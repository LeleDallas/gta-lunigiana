// Terrain for the map build: terrarium DEM -> 4 m node grid, 3x3 blur, river carving,
// road flattening along smoothed, grade-clamped profiles.
import { readFileSync } from "node:fs"

import { arcLengths, BOUNDS, M_PER_DEG, ORIGIN, segDist2, type V } from "./geometry.ts"
import { decodePng } from "./png.ts"

export interface Grid {
  readonly cell: number
  readonly cols: number
  readonly rows: number
  readonly x0: number
  readonly y0: number
  /** Node elevations, row-major, row 0 = south. */
  readonly z: Float64Array
}

const Z = 15, TX0 = 17304, TX1 = 17307, TY0 = 11893, TY1 = 11896

/** Bilinear terrarium sampler in local metres (pixel centres at +0.5). */
export const loadDem = (dir: string): ((x: number, y: number) => number) => {
  const W = (TX1 - TX0 + 1) * 256, H = (TY1 - TY0 + 1) * 256
  const elev = new Float64Array(W * H)
  for (let tx = TX0; tx <= TX1; tx++) for (let ty = TY0; ty <= TY1; ty++) {
    const png = decodePng(readFileSync(`${dir}/${Z}_${tx}_${ty}.png`))
    if (png.width !== 256 || png.height !== 256) throw new Error(`unexpected terrarium tile ${tx}/${ty}`)
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 3
      elev[((ty - TY0) * 256 + y) * W + (tx - TX0) * 256 + x] = png.data[i]! * 256 + png.data[i + 1]! + png.data[i + 2]! / 256 - 32768
    }
  }
  const n = 2 ** Z
  return (x, y) => {
    const lon = ORIGIN.lon + x / M_PER_DEG.lon, lat = ORIGIN.lat + y / M_PER_DEG.lat
    const r = (lat * Math.PI) / 180
    const px = (((lon + 180) / 360) * n - TX0) * 256 - 0.5
    const py = (((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n - TY0) * 256 - 0.5
    const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy
    const g = (gx: number, gy: number) => elev[Math.min(H - 1, Math.max(0, gy)) * W + Math.min(W - 1, Math.max(0, gx))]!
    return g(ix, iy) * (1 - fx) * (1 - fy) + g(ix + 1, iy) * fx * (1 - fy) + g(ix, iy + 1) * (1 - fx) * fy + g(ix + 1, iy + 1) * fx * fy
  }
}

const tileLon = (tx: number) => (tx / 2 ** Z) * 360 - 180
const tileLat = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / 2 ** Z))) * 180) / Math.PI

/**
 * Node grid covering BOUNDS (the last row/col reaches maxX/maxY), sampled from `dem` and 3x3
 * box-blurred. Within 12 m of a tile seam a further 7-tap blur across the seam irons out the
 * ~1 m creases the terrarium tiles have there.
 */
export const makeGrid = (dem: (x: number, y: number) => number, cell = 4): Grid => {
  const cols = Math.ceil((BOUNDS.maxX - BOUNDS.minX) / cell) + 1, rows = Math.ceil((BOUNDS.maxY - BOUNDS.minY) / cell) + 1
  const x0 = BOUNDS.minX, y0 = BOUNDS.minY
  const at = (a: Float64Array, i: number, j: number) => a[Math.min(rows - 1, Math.max(0, j)) * cols + Math.min(cols - 1, Math.max(0, i))]!
  const src = new Float64Array(cols * rows)
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) src[j * cols + i] = dem(x0 + i * cell, y0 + j * cell)
  const z = new Float64Array(cols * rows)
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let s = 0
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += at(src, i + di, j + dj)
    z[j * cols + i] = s / 9
  }
  const blurred = Float64Array.from(z)
  const seamsX: Array<number> = [], seamsY: Array<number> = []
  for (let tx = TX0 + 1; tx <= TX1; tx++) seamsX.push((tileLon(tx) - ORIGIN.lon) * M_PER_DEG.lon)
  for (let ty = TY0 + 1; ty <= TY1; ty++) seamsY.push((tileLat(ty) - ORIGIN.lat) * M_PER_DEG.lat)
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = x0 + i * cell, y = y0 + j * cell
    const acrossX = seamsX.some((sx) => Math.abs(x - sx) <= 12), acrossY = seamsY.some((sy) => Math.abs(y - sy) <= 12)
    if (!acrossX && !acrossY) continue
    let s = 0
    for (let d = -3; d <= 3; d++) s += acrossX ? at(blurred, i + d, j) : at(blurred, i, j + d)
    z[j * cols + i] = s / 7
  }
  return { cell, cols, rows, x0, y0, z }
}

export const sampleGrid = (g: Grid, x: number, y: number): number => {
  const fx = (x - g.x0) / g.cell, fy = (y - g.y0) / g.cell
  const i = Math.min(g.cols - 2, Math.max(0, Math.floor(fx))), j = Math.min(g.rows - 2, Math.max(0, Math.floor(fy)))
  const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j))
  const k = j * g.cols + i
  const s = g.z[k]! + (g.z[k + 1]! - g.z[k]!) * tx, n = g.z[k + g.cols]! + (g.z[k + g.cols + 1]! - g.z[k + g.cols]!) * tx
  return s + (n - s) * ty
}

/** Slope in degrees of cell (i, j) (between nodes (i, j) and (i+1, j+1)), from a 3-cell (12 m) baseline: the DEM resolves ~30 m, finer slopes are noise. */
export const cellSlope = (g: Grid, i: number, j: number): number => {
  const z = (a: number, b: number) => g.z[Math.min(g.rows - 1, Math.max(0, b)) * g.cols + Math.min(g.cols - 1, Math.max(0, a))]!
  const dx = (z(i + 2, j) + z(i + 2, j + 1) - z(i - 1, j) - z(i - 1, j + 1)) / (6 * g.cell)
  const dy = (z(i, j + 2) + z(i + 1, j + 2) - z(i, j - 1) - z(i + 1, j - 1)) / (6 * g.cell)
  return (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI
}

/** Visits nodes within `r` of segment a-b with their distance and projection parameter. */
const forNodesNear = (g: Grid, ax: number, ay: number, bx: number, by: number, r: number, visit: (k: number, d: number, t: number) => void) => {
  const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - g.x0) / g.cell)), i1 = Math.min(g.cols - 1, Math.ceil((Math.max(ax, bx) + r - g.x0) / g.cell))
  const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - g.y0) / g.cell)), j1 = Math.min(g.rows - 1, Math.ceil((Math.max(ay, by) + r - g.y0) / g.cell))
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const { d2, t } = segDist2(g.x0 + i * g.cell, g.y0 + j * g.cell, ax, ay, bx, by)
    if (d2 <= r * r) visit(j * g.cols + i, Math.sqrt(d2), t)
  }
}

/** A polyline resampled every ~`step` m: positions, arc lengths and the sample index of each original vertex. */
export interface Profile { readonly x: Array<number>; readonly y: Array<number>; readonly s: Array<number>; readonly z: Float64Array; readonly vertexSample: Array<number> }

export const resample = (pts: ReadonlyArray<V>, step: number, zAt: (x: number, y: number) => number): Profile => {
  const s = arcLengths(pts)
  const x: Array<number> = [], y: Array<number> = [], ss: Array<number> = [], vertexSample: Array<number> = []
  for (let i = 0; i < pts.length; i++) {
    vertexSample.push(x.length)
    x.push(pts[i]!.x)
    y.push(pts[i]!.y)
    ss.push(s[i]!)
    if (i + 1 === pts.length) break
    const len = s[i + 1]! - s[i]!, n = Math.floor(len / step)
    for (let k = 1; k < n; k++) {
      const t = k / n
      x.push(pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * t)
      y.push(pts[i]!.y + (pts[i + 1]!.y - pts[i]!.y) * t)
      ss.push(s[i]! + len * t)
    }
  }
  return { x, y, s: ss, z: Float64Array.from(x, (xi, k) => zAt(xi, y[k]!)), vertexSample }
}

/** Linear interpolation from a (t = 0) to b (t = 1). */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * Samples of `p` to keep between samples `from` and `to` so that straight lines between kept
 * samples stay within `tol` m of the profile: the `fixed` samples (OSM vertices) plus a
 * Douglas-Peucker pick in (s, z) between each pair of them.
 */
export const keepSamples = (p: Profile, fixed: ReadonlyArray<number>, tol = 0.25): Array<number> => {
  const keep = new Set(fixed)
  const rec = (a: number, b: number) => {
    let worst = tol, at = -1
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs(p.z[k]! - lerp(p.z[a]!, p.z[b]!, (p.s[k]! - p.s[a]!) / (p.s[b]! - p.s[a]! || 1)))
      if (d > worst) [worst, at] = [d, k]
    }
    if (at < 0) return
    keep.add(at)
    rec(a, at)
    rec(at, b)
  }
  for (let i = 0; i + 1 < fixed.length; i++) rec(fixed[i]!, fixed[i + 1]!)
  return [...keep].sort((x, y) => x - y)
}

/** Moving average over +-`half` m of arc length (window shrinks at the ends). */
export const smooth = (p: Profile, half: number): void => {
  const out = new Float64Array(p.z.length)
  let lo = 0, hi = 0, sum = 0
  for (let k = 0; k < p.z.length; k++) {
    while (hi < p.z.length && p.s[hi]! <= p.s[k]! + half) sum += p.z[hi++]!
    while (p.s[lo]! < p.s[k]! - half) sum -= p.z[lo++]!
    out[k] = sum / (hi - lo)
  }
  p.z.set(out)
}

/** Hard elevation at sample `k`; `min`/`max` make it a bound that only binds when the fit crosses it. */
export interface Pin { readonly k: number; readonly z: number; readonly kind?: "min" | "max" }

const FADE = 30 // m over which a pin pulls the profile before the grade fit
const CAP = 4 // m a fitted profile may stray from the smoothed ground before its grade limit is relaxed there
const RELAX = 1.5 // largest factor on a grade limit (tertiary 15%, rail 3.75%)
const RELAX_REACH = 60 // m around a stray sample whose segments get relaxed

/** Envelope of z within the grade budget `t` (cumulative grade x arc length): `dir` = 1 the highest profile at or below z, -1 the lowest at or above. */
const envelope = (t: Float64Array, z: Float64Array, dir: 1 | -1): Float64Array => {
  const e = Float64Array.from(z)
  for (let k = 1; k < e.length; k++) e[k] = dir * Math.min(dir * e[k]!, dir * e[k - 1]! + t[k]! - t[k - 1]!)
  for (let k = e.length - 2; k >= 0; k--) e[k] = dir * Math.min(dir * e[k]!, dir * e[k + 1]! + t[k + 1]! - t[k]!)
  return e
}

/** One fit through hard pins: pins pulled in over FADE m, midpoint of the two grade envelopes (cut and fill split evenly), then each stretch clamped into its two pins' cones. */
const fitOnce = (p: Profile, natural: Float64Array, t: Float64Array, pins: ReadonlyArray<Pin>): void => {
  const z = Float64Array.from(natural)
  for (let k = 0; k < z.length; k++) {
    let wsum = 0, dsum = 0
    for (const pn of pins) {
      const w = Math.max(0, 1 - Math.abs(p.s[k]! - p.s[pn.k]!) / FADE)
      wsum += w
      dsum += w * (pn.z - natural[pn.k]!)
    }
    z[k] = z[k]! + dsum / Math.max(1, wsum)
  }
  const lo = envelope(t, z, 1), hi = envelope(t, z, -1)
  for (let k = 0; k < z.length; k++) z[k] = (lo[k]! + hi[k]!) / 2
  const sorted = [...pins].sort((a, b) => a.k - b.k)
  for (let k = 0, i = -1; k < z.length; k++) {
    while (i + 1 < sorted.length && sorted[i + 1]!.k <= k) i++
    const a = sorted[i], b = sorted[i + 1]
    const da = a ? t[k]! - t[a.k]! : 0, db = b ? t[b.k]! - t[k]! : 0
    const up = Math.min(a ? a.z + da : Number.MAX_VALUE, b ? b.z + db : Number.MAX_VALUE)
    const down = Math.max(a ? a.z - da : -Number.MAX_VALUE, b ? b.z - db : -Number.MAX_VALUE)
    if (down <= up + 1e-9) z[k] = Math.min(up, Math.max(down, z[k]!))
    else if (a && b) z[k] = lerp(a.z, b.z, (p.s[k]! - p.s[a.k]!) / (p.s[b.k]! - p.s[a.k]!)) // conflicting pins: a straight line
  }
  p.z.set(z)
}

/**
 * Grade-limited fit of the (smoothed) profile through `pins`. Violated bounds become pins and the
 * fit is redone; where it strays more than CAP m from the smoothed ground, the grade limit of the
 * surrounding RELAX_REACH m is raised step by step, up to RELAX times `grade`.
 */
export const fitProfile = (p: Profile, grade: number, pins: ReadonlyArray<Pin>): void => {
  const natural = Float64Array.from(p.z), n = p.z.length
  const g = new Float64Array(Math.max(0, n - 1)).fill(grade)
  const hard = new Map<number, number>()
  for (const pn of pins) if (pn.kind === undefined && !hard.has(pn.k)) hard.set(pn.k, pn.z)
  const bounds = pins.filter((pn) => pn.kind !== undefined)
  for (let round = 0; round < 12; round++) {
    const t = new Float64Array(n)
    for (let k = 1; k < n; k++) t[k] = t[k - 1]! + g[k - 1]! * (p.s[k]! - p.s[k - 1]!)
    fitOnce(p, natural, t, [...hard].map(([k, z]) => ({ k, z })))
    const broken = bounds.filter((b) => !hard.has(b.k) && (b.kind === "min" ? p.z[b.k]! < b.z - 1e-6 : p.z[b.k]! > b.z + 1e-6))
    for (const b of broken) hard.set(b.k, b.z)
    let relaxed = false
    for (let k = 0; k < n; k++) {
      if (Math.abs(p.z[k]! - natural[k]!) <= CAP) continue
      for (let j = 0; j + 1 < n; j++) if (Math.abs(p.s[j]! - p.s[k]!) <= RELAX_REACH && g[j]! < grade * RELAX) [g[j], relaxed] = [Math.min(grade * RELAX, g[j]! * 1.1), true]
    }
    if (broken.length === 0 && !relaxed) return
  }
}

/**
 * Lowers the terrain along a water-surface profile: the bed `depth`/2 below the surface inside w/2,
 * a gravel slope to `bed`, then a one-cell bank back to the terrain. Uses min(), so order never
 * matters; nodes with `keep(n)` (road cores) are left alone.
 */
export const carve = (g: Grid, p: Profile, w: number, bed: number, depth: number, keep: (n: number) => boolean = () => false): void => {
  const reach = bed + g.cell
  for (let k = 0; k + 1 < p.z.length; k++)
    forNodesNear(g, p.x[k]!, p.y[k]!, p.x[k + 1]!, p.y[k + 1]!, reach, (n, d, t) => {
      const surface = lerp(p.z[k]!, p.z[k + 1]!, t), floor = surface - depth / 2, gravel = surface + depth / 4
      const z = d <= w / 2 ? floor : d <= bed ? lerp(floor, gravel, (d - w / 2) / Math.max(1e-6, bed - w / 2)) : lerp(gravel, g.z[n]!, (d - bed) / g.cell)
      if (z < g.z[n]! && !keep(n)) g.z[n] = z
    })
}

/**
 * Writes a road profile into the grid: nodes within `core` take the road elevation, the next
 * `blend` m fade back to the terrain. `owner` holds the rank of the road that wrote each core
 * node (255 = none): ranks <= `rank` win, so earlier (higher) classes keep junctions.
 * `protect` marks river nodes no road may touch; segments from sample k with `skip(k)` (bridges, tunnels) write nothing.
 */
export const flatten = (g: Grid, p: Profile, core: number, blend: number, rank: number, owner: Uint8Array, protect: Uint8Array, skip: (k: number) => boolean): void => {
  const best = new Map<number, { d: number; z: number }>()
  for (let k = 0; k + 1 < p.z.length; k++)
    if (!skip(k)) forNodesNear(g, p.x[k]!, p.y[k]!, p.x[k + 1]!, p.y[k + 1]!, core + blend, (n, d, t) => {
      const cur = best.get(n)
      if (cur === undefined || d < cur.d) best.set(n, { d, z: lerp(p.z[k]!, p.z[k + 1]!, t) })
    })
  for (const [n, { d, z }] of [...best].sort((a, b) => a[0] - b[0])) {
    if (protect[n] === 1 || owner[n]! <= rank) continue
    if (d <= core) {
      g.z[n] = z
      owner[n] = rank
    } else if (owner[n] === 255) g.z[n] = lerp(z, g.z[n]!, (d - core) / blend)
  }
}
