/**
 * Where the ground is, in render space. Three world = (x = east, y = elevation − ELEVATION_BASE,
 * z = −north). The terrain mesh, the road ribbons and every actor read their heights here, so
 * what is drawn and what stands on it agree.
 *
 * @module render/ground
 */
import { MAP, roadClassOf, type RoadClass } from "../sim/map/index.ts"
import { segDist2 } from "../tools/geometry.ts"

/** Metres a.s.l. subtracted from every elevation before it reaches the GPU (the map spans ≈150–980 m). */
const ELEVATION_BASE = 200

/** Render y of a map elevation (m a.s.l.). */
export const yOf = (z: number): number => z - ELEVATION_BASE

/** How far each road class floats above what it covers (m); wider classes on top, so junctions never z-fight. */
export const ROAD_LIFT = {
  tertiary: 0.16, unclassified: 0.14, residential: 0.12, service: 0.1, track: 0.08, steps: 0.07, path: 0.06
} as const satisfies Record<RoadClass, number>

const hm = MAP.heightmap
/**
 * Terrain node height at grid index (i, j), row 0 = south; indices outside the grid clamp to the
 * edge, which is how the apron beyond the map bounds continues the landscape.
 */
export const terrainNodeY = (i: number, j: number): number =>
  yOf(hm.data[Math.min(hm.rows - 1, Math.max(0, j)) * hm.cols + Math.min(hm.cols - 1, Math.max(0, i))]! / 10)

/**
 * Terrain height under (x, y) on the rendered mesh: each 4 m cell is split along its south-west to
 * north-east diagonal, exactly like the triangles the terrain builder emits.
 */
export const terrainY = (x: number, y: number): number => {
  const fx = (x - hm.x0) / hm.cell, fy = (y - hm.y0) / hm.cell
  const i = Math.floor(fx), j = Math.floor(fy)
  const u = fx - i, v = fy - j
  const sw = terrainNodeY(i, j), se = terrainNodeY(i + 1, j), nw = terrainNodeY(i, j + 1), ne = terrainNodeY(i + 1, j + 1)
  return u >= v ? sw + (se - sw) * u + (ne - se) * v : sw + (ne - nw) * u + (nw - sw) * v
}

interface RoadSegment {
  readonly ax: number
  readonly ay: number
  readonly bx: number
  readonly by: number
  readonly za: number
  readonly zb: number
  readonly half: number
  readonly lift: number
  /** Bridge or tunnel: the surface is the profile, never the terrain. */
  readonly lifted: boolean
}

const BUCKET = 16
const buckets = new Map<number, Array<RoadSegment>>()
const keyOf = (bx: number, by: number) => bx * 4096 + by
for (const road of MAP.roads) {
  const lifted = road.bridge === true || road.tunnel === true
  const lift = ROAD_LIFT[roadClassOf(road)]
  for (let k = 0; k + 1 < road.z.length; k++) {
    const s: RoadSegment = {
      ax: road.pts[2 * k]!, ay: road.pts[2 * k + 1]!, bx: road.pts[2 * k + 2]!, by: road.pts[2 * k + 3]!,
      za: road.z[k]!, zb: road.z[k + 1]!, half: road.w / 2 + 0.3, lift, lifted
    }
    const x0 = Math.floor((Math.min(s.ax, s.bx) - s.half) / BUCKET), x1 = Math.floor((Math.max(s.ax, s.bx) + s.half) / BUCKET)
    const y0 = Math.floor((Math.min(s.ay, s.by) - s.half) / BUCKET), y1 = Math.floor((Math.max(s.ay, s.by) + s.half) / BUCKET)
    for (let bx = x0; bx <= x1; bx++) for (let by = y0; by <= y1; by++) {
      const list = buckets.get(keyOf(bx + 2048, by + 2048))
      if (list === undefined) buckets.set(keyOf(bx + 2048, by + 2048), [s])
      else list.push(s)
    }
  }
}

/** Surface y of a road whose profile is `z` (m a.s.l.) at (x, y): at-grade roads never dip under the terrain mesh. */
export const surfaceY = (z: number, x: number, y: number, lift: number, lifted: boolean): number =>
  (lifted ? yOf(z) : Math.max(yOf(z), terrainY(x, y))) + lift

/** Surface y of segment `s` at (x, y), or undefined when (x, y) is off it. */
const onSegment = (s: RoadSegment, x: number, y: number): number | undefined => {
  const { d2, t } = segDist2(x, y, s.ax, s.ay, s.bx, s.by)
  return d2 > s.half * s.half ? undefined : surfaceY(s.za + (s.zb - s.za) * t, x, y, s.lift, s.lifted)
}

/** A bridge deck or tunnel within this height (m) of where an actor was is the one it is on. */
const ON_DECK = 0.5

/**
 * Where an actor at (x, y) stands. At-grade roads are part of the ground: the highest of them and
 * the terrain. Bridge decks and tunnels compete with that ground for the one nearest `near`, the
 * actor's previous height, so it stays on the level it was on; without `near`, the highest wins.
 * A deck within ON_DECK of `near` wins outright: on a ramp over a gully the ground below can be
 * nearer than the climbing deck, and the actor must not drop onto it.
 */
export const groundY = (x: number, y: number, near?: number): number => {
  const segments = buckets.get(keyOf(Math.floor(x / BUCKET) + 2048, Math.floor(y / BUCKET) + 2048)) ?? []
  let best = terrainY(x, y)
  for (const s of segments) {
    const h = s.lifted ? undefined : onSegment(s, x, y)
    if (h !== undefined && h > best) best = h
  }
  let score = near === undefined ? -best : Math.abs(best - near)
  for (const s of segments) {
    const h = s.lifted ? onSegment(s, x, y) : undefined
    if (h === undefined) continue
    const off = near === undefined ? 0 : Math.abs(h - near)
    const sc = near === undefined ? -h : off < ON_DECK ? off - ON_DECK : off
    if (sc < score) [best, score] = [h, sc]
  }
  return best
}

/** Render heights under the front and rear of a vehicle `length` long at (x, y) heading `angle`, each wheel kept on the level it was on (`near`). */
export const axleY = (x: number, y: number, angle: number, length: number, near?: { readonly front: number; readonly rear: number }) => {
  const dx = (Math.cos(angle) * length) / 2, dy = (Math.sin(angle) * length) / 2
  return { front: groundY(x + dx, y + dy, near?.front), rear: groundY(x - dx, y - dy, near?.rear) }
}
