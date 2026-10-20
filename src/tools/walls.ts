// Collision walls: outlines of the blocked 4 m cells (water, steep ground; marching squares,
// simplified, <= 16 m pieces) plus building edges, barriers, map bounds and road-exit caps.
// Flat (ax, ay, bx, by) arrays.
import type { Barrier } from "../sim/map/index.ts"
import { isDrivable } from "../sim/map/kinds.ts"
import type { BuildingF, RoadF, WaterF } from "./features.ts"
import { BOUNDS, flatRing, pointInRing, r1, ringBox, segDist2, segIndex, signedArea } from "./geometry.ts"
import { cellSlope, type Grid } from "./terrain.ts"

const RUN = 16 // max wall segment length, m
const WALK_SLOPE = 35, DRIVE_SLOPE = 25
/** Wall simplification tolerance, m; road buffers below are widened by it so walls never reach w/2. */
const SLACK = 1.5

/** Pushes a-b as pieces no longer than `run`. */
const pushSplit = (out: Array<number>, ax: number, ay: number, bx: number, by: number, run = RUN) => {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / run))
  for (let k = 0; k < n; k++)
    out.push(r1(ax + ((bx - ax) * k) / n), r1(ay + ((by - ay) * k) / n), r1(ax + ((bx - ax) * (k + 1)) / n), r1(ay + ((by - ay) * (k + 1)) / n))
}
const pushPolyline = (out: Array<number>, pts: ReadonlyArray<number>, closed: boolean) => {
  const n = pts.length / 2
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n
    pushSplit(out, pts[2 * i]!, pts[2 * i + 1]!, pts[2 * j]!, pts[2 * j + 1]!)
  }
}

/**
 * Marching squares over the blocked cells (centres = samples, outside = free): closed loops of
 * crossing points midway between blocked and free centres, blocked side on the left. At saddles
 * the diagonal blocked corners join, so one-cell diagonal strips (streams) stay one loop. Returns loops of [x, y] in metres (first point repeated last).
 */
const traceLoops = (g: Pick<Grid, "cell" | "cols" | "rows" | "x0" | "y0">, blocked: Uint8Array): Array<Array<readonly [number, number]>> => {
  const cw = g.cols - 1, ch = g.rows - 1, c = g.cell
  const b = (i: number, j: number) => (i < 0 || j < 0 || i >= cw || j >= ch ? 0 : blocked[j * cw + i]!)
  // Crossing ids: edge between centres (i,j)-(i+1,j) -> h, (i,j)-(i,j+1) -> v.
  const hId = (i: number, j: number) => ((j + 1) * (cw + 2) + i + 1) * 2, vId = (i: number, j: number) => hId(i, j) + 1
  const xy = (id: number): readonly [number, number] => {
    const cell = Math.floor(id / 2), i = (cell % (cw + 2)) - 1, j = Math.floor(cell / (cw + 2)) - 1
    return id % 2 === 0 ? [g.x0 + (i + 1) * c, g.y0 + (j + 0.5) * c] : [g.x0 + (i + 0.5) * c, g.y0 + (j + 1) * c]
  }
  const next = new Map<number, number>()
  for (let j = -1; j < ch; j++) for (let i = -1; i < cw; i++) {
    // Square corners counter-clockwise: SW, SE, NE, NW; edge k runs corner k -> k+1.
    const v = [b(i, j), b(i + 1, j), b(i + 1, j + 1), b(i, j + 1)]
    if (v[0] === v[1] && v[1] === v[2] && v[2] === v[3]) continue
    const edge = [hId(i, j), vId(i + 1, j), hId(i, j + 1), vId(i, j)]
    for (let k = 0; k < 4; k++) {
      if (!(v[k] === 1 && v[(k + 1) % 4] === 0)) continue // leaves the blocked region along edge k
      let e = (k + 1) % 4
      while (!(v[e] === 0 && v[(e + 1) % 4] === 1)) e = (e + 1) % 4 // next entering edge counter-clockwise
      next.set(edge[k]!, edge[e]!)
    }
  }
  const loops: Array<Array<readonly [number, number]>> = []
  for (const start of [...next.keys()].sort((a, d) => a - d)) {
    if (!next.has(start)) continue
    const loop = [xy(start)]
    let cur = start
    do {
      const to = next.get(cur)!
      next.delete(cur)
      loop.push(xy(to))
      cur = to
    } while (cur !== start)
    loops.push(loop)
  }
  return loops
}

/** Douglas-Peucker on a closed loop (first point repeated last), split at the point farthest from the start. */
const simplifyLoop = (pts: ReadonlyArray<readonly [number, number]>, tol: number): Array<readonly [number, number]> => {
  const n = pts.length - 1
  if (n <= 4) return [...pts]
  const keep = new Uint8Array(n + 1)
  const rec = (a: number, z: number) => {
    const [ax, ay] = pts[a]!, [zx, zy] = pts[z]!, len = Math.hypot(zx - ax, zy - ay) || 1
    let worst = tol, at = -1
    for (let k = a + 1; k < z; k++) {
      const d = Math.abs((pts[k]![0] - ax) * (zy - ay) - (pts[k]![1] - ay) * (zx - ax)) / len
      if (d > worst) [worst, at] = [d, k]
    }
    if (at < 0) return
    keep[at] = 1
    rec(a, at)
    rec(at, z)
  }
  let far = 1
  for (let k = 1; k < n; k++) if (Math.hypot(pts[k]![0] - pts[0]![0], pts[k]![1] - pts[0]![1]) > Math.hypot(pts[far]![0] - pts[0]![0], pts[far]![1] - pts[0]![1])) far = k
  keep[0] = keep[far] = keep[n] = 1
  rec(0, far)
  rec(far, n)
  return pts.filter((_, k) => keep[k] === 1)
}

/** Walls around the blocked cells: traced loops, simplified within `tol` m, split into <= RUN m segments, into every list in `outs`. */
const boundary = (g: Pick<Grid, "cell" | "cols" | "rows" | "x0" | "y0">, blocked: Uint8Array, outs: ReadonlyArray<Array<number>>, tol = SLACK) => {
  for (const loop of traceLoops(g, blocked)) {
    const pts = simplifyLoop(loop, tol)
    for (let i = 0; i + 1 < pts.length; i++) for (const out of outs) pushSplit(out, pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1])
  }
}

/** Half-width of the corridor kept open where a road centreline runs through or along a footprint. */
const ARCH = 1.2
/** Raster cell for footprints cut by such a corridor, m. */
const FOOTPRINT_RES = 0.2
/** Smallest piece of a clipped footprint kept, m². */
const MIN_PIECE = 4

/**
 * Roads that clip the footprints they cross (`clipBuildings`): drivable, not tunnels. OSM and the
 * CTR disagree by a metre or two, and none of these is tagged as a passage, so the house gives way.
 * The rest (tunnels, paths and steps under arches) only open a corridor in the walls.
 */
const clips = (r: RoadF) => isDrivable(r.cls) && r.tunnel !== true

/**
 * Footprint `b` rasterised at FOOTPRINT_RES m minus the corridors where a centreline of `roads`
 * comes within min(w/2, ARCH), or undefined when no corridor reaches inside it.
 */
const carved = (b: BuildingF, roads: ReadonlyArray<RoadF>) => {
  const [x0, y0, x1, y1] = ringBox(b.outer)
  const cuts: Array<readonly [number, number, number, number, number]> = []
  for (const r of roads) for (let i = 0; i + 1 < r.pts.length; i++) {
    const p = r.pts[i]!, q = r.pts[i + 1]!, h = Math.min(r.w / 2, ARCH)
    if (Math.max(p.x, q.x) > x0 - h && Math.min(p.x, q.x) < x1 + h && Math.max(p.y, q.y) > y0 - h && Math.min(p.y, q.y) < y1 + h) cuts.push([p.x, p.y, q.x, q.y, h])
  }
  if (cuts.length === 0) return undefined
  const res = FOOTPRINT_RES, gx = x0 - res, gy = y0 - res
  const cw = Math.ceil((x1 - x0) / res) + 2, ch = Math.ceil((y1 - y0) / res) + 2
  const blocked = new Uint8Array(cw * ch)
  let cut = false
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    const x = gx + (i + 0.5) * res, y = gy + (j + 0.5) * res
    if (!pointInRing(x, y, b.outer) || (b.holes ?? []).some((h) => pointInRing(x, y, h))) continue
    if (cuts.some(([ax, ay, bx, by, h]) => segDist2(x, y, ax, ay, bx, by).d2 < h * h)) cut = true
    else blocked[j * cw + i] = 1
  }
  return cut ? { grid: { cell: res, cols: cw + 1, rows: ch + 1, x0: gx, y0: gy }, blocked } : undefined
}

/**
 * Buildings with every corridor of a road that `clips` cut out of the footprint: one building per
 * piece left (same id, style and height; slivers under MIN_PIECE m² dropped), traced like the
 * walls, so the house drawn and the house collided with are one outline.
 */
export const clipBuildings = (buildings: ReadonlyArray<BuildingF>, roads: ReadonlyArray<RoadF>): Array<BuildingF> => {
  const clipping = roads.filter(clips)
  return buildings.flatMap((b) => {
    const c = carved(b, clipping)
    if (c === undefined) return [b]
    const rings = traceLoops(c.grid, c.blocked).map((loop) => simplifyLoop(loop, 0.15).slice(0, -1))
    const holes = rings.filter((r) => signedArea(r) < 0).map((r) => flatRing(r, false)).filter((r) => r !== undefined)
    const { holes: _, ...rest } = b
    return rings.flatMap((r) => {
      const outer = signedArea(r) >= MIN_PIECE ? flatRing(r, true) : undefined
      if (outer === undefined) return []
      const inside = holes.filter((h) => pointInRing(h[0]!, h[1]!, outer))
      return [{ ...rest, outer, ...(inside.length > 0 ? { holes: inside } : {}) }]
    })
  })
}

/**
 * Building edges into every list in `outs`. Where a tunnel, path or steps centreline comes within
 * min(w/2, ARCH) of the footprint, the walls are instead the outline of the footprint minus those
 * corridors: passages and steps under arches stay open, the interior stays closed.
 */
const pushBuilding = (outs: ReadonlyArray<Array<number>>, b: BuildingF, arches: ReadonlyArray<RoadF>) => {
  const c = carved(b, arches)
  if (c !== undefined) return boundary(c.grid, c.blocked, outs, 0.15)
  for (const ring of [b.outer, ...(b.holes ?? [])]) for (const out of outs) pushPolyline(out, ring, true)
}

interface Walls { readonly walk: Array<number>; readonly drive: Array<number>; readonly walkCells: number; readonly driveCells: number }

export const buildWalls = (g: Grid, roads: ReadonlyArray<RoadF>, water: ReadonlyArray<WaterF>, buildings: ReadonlyArray<BuildingF>, barriers: ReadonlyArray<Barrier>): Walls => {
  const wet = segIndex<null>(), banks = segIndex<null>()
  for (const w of water) {
    wet.addLine(w.pts, Math.max(w.w / 2, 2), null)
    // Carved banks of the larger streams are steep by construction; the water walls already stop movement there.
    if (w.w >= 4) banks.addLine(w.pts, w.bed + 2 * g.cell, null)
  }
  // Road buffers are measured from cell centres; walls sit midway between centres (half a cell) and may
  // move SLACK when simplified, so pad the buffers by both to keep every wall at least w/2 from the centreline.
  const pad = g.cell / 2 + SLACK
  const near = segIndex<RoadF>()
  for (const r of roads) near.addLine(r.pts, Math.max(r.w / 2, 1.5) + 1.5 + pad, r) // tunnels too: they are short underpasses here
  const cw = g.cols - 1, ch = g.rows - 1
  // Steep cells, majority-filtered (3x3) so the walls follow slopes, not single-cell bumps.
  const steep = (limit: number) => {
    const raw = new Uint8Array(cw * ch)
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++)
      raw[j * cw + i] = cellSlope(g, i, j) > limit && !banks.covers(g.x0 + (i + 0.5) * g.cell, g.y0 + (j + 0.5) * g.cell) ? 1 : 0
    const out = new Uint8Array(cw * ch)
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      let n = 0
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) n += raw[Math.min(ch - 1, Math.max(0, j + dj)) * cw + Math.min(cw - 1, Math.max(0, i + di))]!
      out[j * cw + i] = n >= 5 ? 1 : 0
    }
    return out
  }
  const steepWalk = steep(WALK_SLOPE), steepDrive = steep(DRIVE_SLOPE)
  const walkBlocked = new Uint8Array(cw * ch), driveBlocked = new Uint8Array(cw * ch)
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    const k = j * cw + i, x = g.x0 + (i + 0.5) * g.cell, y = g.y0 + (j + 0.5) * g.cell
    const water = wet.covers(x, y)
    if (!water && steepDrive[k] === 0 && steepWalk[k] === 0) continue
    let walkRoad = false, driveRoad = false, driveCrossing = false
    near.within(x, y, (s, d2) => {
      const d = Math.sqrt(d2), r = s.data
      if (d < Math.max(r.w / 2, 1.5) + pad) walkRoad = true // every class is walkable; paths keep >= 1.5 m
      if (isDrivable(r.cls)) {
        if (d < r.w / 2 + 1.5 + pad) driveRoad = true
        if (d < r.w / 2 + pad) driveCrossing = true // bridge deck or ford
      }
    })
    walkBlocked[k] = !walkRoad && (water || steepWalk[k] === 1) ? 1 : 0
    driveBlocked[k] = (water && !driveCrossing) || (steepDrive[k] === 1 && !driveRoad) ? 1 : 0
  }
  const walk: Array<number> = [], drive: Array<number> = []
  boundary(g, walkBlocked, [walk])
  boundary(g, driveBlocked, [drive])
  const arches = roads.filter((r) => !clips(r))
  for (const b of buildings) pushBuilding([walk, drive], b, arches)
  for (const b of barriers) {
    if (b.kind !== "guard_rail") pushPolyline(walk, b.pts, false)
    pushPolyline(drive, b.pts, false)
  }
  const { minX, minY, maxX, maxY } = BOUNDS
  for (const out of [walk, drive]) for (const [ax, ay, bx, by] of [[minX, minY, maxX, minY], [maxX, minY, maxX, maxY], [maxX, maxY, minX, maxY], [minX, maxY, minX, minY]] as const)
    pushSplit(out, ax, ay, bx, by, 64)
  // Road-block caps a few metres inside the edge where drivable roads leave the play area.
  for (const r of roads) {
    if (!isDrivable(r.cls)) continue
    for (const [end, prev] of [[r.pts[0]!, r.pts[1]!], [r.pts.at(-1)!, r.pts.at(-2)!]] as const) {
      if (end.id !== undefined) continue
      const len = Math.hypot(end.x - prev.x, end.y - prev.y) || 1
      const tx = (end.x - prev.x) / len, ty = (end.y - prev.y) / len, cx = end.x - tx * 4, cy = end.y - ty * 4, h = r.w / 2 + 1
      pushSplit(drive, cx - ty * h, cy + tx * h, cx + ty * h, cy - tx * h)
    }
  }
  return { walk, drive, walkCells: walkBlocked.reduce((s, v) => s + v, 0), driveCells: driveBlocked.reduce((s, v) => s + v, 0) }
}
