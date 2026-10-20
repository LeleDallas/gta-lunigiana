/**
 * Circle-vs-segment collision, which ritmo-math does not have (Collide2 covers
 * circles against axis-aligned boxes only). Mirrors `Collide2.moveCircle`:
 * swept, pushes out first, slides along walls, up to 4 contacts per call.
 * Ported from the verified `.research/scratch-ritmo-addons/sim/collide.ts`.
 *
 * @module collide
 */
import { Collide2, Scalar, SpatialGrid, Vec2 } from "@typeonce/ritmo-math"

import type { Segment } from "./map/index.ts"

/** First contact of a circle at `o` moving by `d` with the capsule of radius `r` around `s`, or undefined. */
export const sweepCircleSegment = (o: Vec2.Vec2, d: Vec2.Vec2, r: number, s: Segment): Collide2.Hit | undefined => {
  const ex = s.bx - s.ax
  const ey = s.by - s.ay
  const len2 = ex * ex + ey * ey
  let best: Collide2.Hit | undefined
  if (len2 > 1e-12) {
    const len = Math.sqrt(len2)
    let nx = -ey / len
    let ny = ex / len
    let side = (o.x - s.ax) * nx + (o.y - s.ay) * ny
    if (side < 0) {
      nx = -nx
      ny = -ny
      side = -side
    }
    const into = d.x * nx + d.y * ny
    if (into < 0 && side >= r) {
      const t = (r - side) / into
      const px = o.x + d.x * t - s.ax
      const py = o.y + d.y * t - s.ay
      const u = (px * ex + py * ey) / len2
      if (t <= 1 && u >= 0 && u <= 1) best = { time: t, nx, ny }
    }
  }
  if (best !== undefined) return best
  // End caps: Collide2.rayCircle is the exact ray-vs-circle entry time.
  for (const [cx, cy] of [[s.ax, s.ay], [s.bx, s.by]] as const) {
    const t = Collide2.rayCircle(o.x, o.y, d.x, d.y, cx, cy, r)
    if (t === undefined || (best !== undefined && t >= best.time)) continue
    const hx = o.x + d.x * t - cx
    const hy = o.y + d.y * t - cy
    const l = Math.sqrt(hx * hx + hy * hy) || 1
    best = { time: t, nx: hx / l, ny: hy / l }
  }
  return best
}

/** Distance from (x, y) to segment `s`, m. */
export const segmentDistance = (s: Segment, x: number, y: number): number => {
  const ex = s.bx - s.ax, ey = s.by - s.ay
  const len2 = ex * ex + ey * ey
  const u = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - s.ax) * ex + (y - s.ay) * ey) / len2)) : 0
  return Math.sqrt((x - s.ax - ex * u) ** 2 + (y - s.ay - ey * u) ** 2)
}

/**
 * Pushes a circle out of every segment it overlaps, leaving `skin`. Repeats
 * (up to PUSH_PASSES) because leaving one wall can push it into another, as
 * in a concave corner.
 */
export const pushOutSegments = (c: Vec2.Vec2, r: number, segs: ReadonlyArray<Segment>, skin = Collide2.defaultSkin): Vec2.Vec2 => {
  let x = c.x
  let y = c.y
  for (let pass = 0; pass < PUSH_PASSES; pass++) {
    let pushed = false
    for (const s of segs) {
      const ex = s.bx - s.ax
      const ey = s.by - s.ay
      const len2 = ex * ex + ey * ey
      const u = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - s.ax) * ex + (y - s.ay) * ey) / len2)) : 0
      const qx = s.ax + ex * u
      const qy = s.ay + ey * u
      const dx = x - qx
      const dy = y - qy
      const dist2 = dx * dx + dy * dy
      if (dist2 >= r * r) continue
      pushed = true
      if (dist2 > 1e-12) {
        const dist = Math.sqrt(dist2)
        x = qx + (dx / dist) * (r + skin)
        y = qy + (dy / dist) * (r + skin)
      } else {
        const len = Math.sqrt(len2) || 1
        x = qx - (ey / len) * (r + skin)
        y = qy + (ex / len) * (r + skin)
      }
    }
    if (!pushed) break
  }
  return { x, y }
}

// ponytail: a fixed number of push-out passes; a body squeezed between walls closer than its diameter can still overlap one. Upgrade: solve the contacts together.
const PUSH_PASSES = 4

/**
 * Moves a rigid group of circles (a pedestrian = one offset at 0,0; a car = a
 * row of offsets along its axis) by one shared `delta`, stopping at the earliest
 * contact of any circle and sliding along it.
 */
export const moveCircles = (
  center: Vec2.Vec2,
  offsets: ReadonlyArray<Vec2.Vec2>,
  delta: Vec2.Vec2,
  r: number,
  segs: ReadonlyArray<Segment>,
  skin = Collide2.defaultSkin
): Collide2.MoveResult => {
  // Push-out per circle, repeated: freeing one circle of a car can push another into a wall.
  let position = center
  for (let pass = 0; pass < PUSH_PASSES; pass++) {
    const before = position
    for (const off of offsets) {
      const part = Vec2.add(position, off)
      position = Vec2.add(position, Vec2.subtract(pushOutSegments(part, r, segs, skin), part))
    }
    if (position.x === before.x && position.y === before.y) break
  }
  let rx = delta.x
  let ry = delta.y
  let blocked = false
  for (let i = 0; i < 4; i++) {
    if (rx * rx + ry * ry < 1e-12) break
    let hit: Collide2.Hit | undefined
    for (const off of offsets) {
      const origin = Vec2.add(position, off)
      for (const s of segs) {
        const h = sweepCircleSegment(origin, { x: rx, y: ry }, r, s)
        if (h !== undefined && (hit === undefined || h.time < hit.time)) hit = h
      }
    }
    if (hit === undefined) {
      position = { x: position.x + rx, y: position.y + ry }
      break
    }
    blocked = true
    position = { x: position.x + rx * hit.time + hit.nx * skin, y: position.y + ry * hit.time + hit.ny * skin }
    const remaining = 1 - hit.time
    rx *= remaining
    ry *= remaining
    const into = rx * hit.nx + ry * hit.ny
    if (into < 0) {
      rx -= into * hit.nx
      ry -= into * hit.ny
    }
  }
  return { position, blocked }
}

/**
 * Static broad phase over wall segments: a SpatialGrid built once and never
 * cleared. The returned query yields every segment whose grid cells overlap
 * the box (a superset; run the exact test). Its result array is reused by the
 * next call, so copy it if you need to keep it.
 */
export const indexSegments = (segs: ReadonlyArray<Segment>, cellSize: number) => {
  const size = Scalar.Positive.result(cellSize)
  if (!size.ok) throw new Error(`cell size must be > 0, got ${cellSize}`)
  const grid = SpatialGrid.make(size.value)
  segs.forEach((s, i) => {
    const hx = (s.bx - s.ax) / 2
    const hy = (s.by - s.ay) / 2
    grid.insert(i, s.ax + hx, s.ay + hy, Math.sqrt(hx * hx + hy * hy))
  })
  const found: Array<Segment> = []
  return (minX: number, minY: number, maxX: number, maxY: number): ReadonlyArray<Segment> => {
    found.length = 0
    grid.forEachIn(minX, minY, maxX, maxY, (i) => found.push(segs[i]!))
    return found
  }
}
