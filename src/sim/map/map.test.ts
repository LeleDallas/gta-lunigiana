import assert from "node:assert/strict"
import { test } from "node:test"

import { Ops } from "@typeonce/ritmo-math"

import { pointInRing as inRing } from "../../tools/geometry.ts"
import { moveCircles, segmentDistance } from "../collide.ts"
import { BUILDING_STYLES, districtAt, graph, heightAt, isAreaKind, isDrivable, MAP, ROAD_CLASSES, type Segment, wallsNear } from "./index.ts"

const { hypot } = Ops
const segsOf = (flat: ReadonlyArray<number>, closed = false): Array<Segment> => {
  const out: Array<Segment> = [], n = flat.length / 2
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n
    out.push({ ax: flat[2 * i]!, ay: flat[2 * i + 1]!, bx: flat[2 * j]!, by: flat[2 * j + 1]! })
  }
  return out
}
/** Points every `step` m along a flat polyline. */
const samples = (pts: ReadonlyArray<number>, step: number) => segsOf(pts).flatMap((s) => {
  const len = hypot(s.bx - s.ax, s.by - s.ay), out: Array<{ x: number; y: number }> = []
  for (let d = 0; d < len; d += step) out.push({ x: s.ax + ((s.bx - s.ax) * d) / len, y: s.ay + ((s.by - s.ay) * d) / len })
  return out
})
/** Crossing points of two flat polylines with the parameter along each segment. */
const crossings = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
  const out: Array<{ x: number; y: number; i: number; t: number; j: number; u: number }> = []
  segsOf(a).forEach((p, i) => segsOf(b).forEach((q, j) => {
    const ex = p.bx - p.ax, ey = p.by - p.ay, fx = q.bx - q.ax, fy = q.by - q.ay, den = ex * fy - ey * fx
    if (den === 0) return
    const t = ((q.ax - p.ax) * fy - (q.ay - p.ay) * fx) / den, u = ((q.ax - p.ax) * ey - (q.ay - p.ay) * ex) / den
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push({ x: p.ax + ex * t, y: p.ay + ey * t, i, t, j, u })
  }))
  return out
}
const zAt = (z: ReadonlyArray<number>, i: number, t: number) => z[i]! + (z[i + 1]! - z[i]!) * t
const clear = (kind: "walk" | "drive", x: number, y: number, r: number) => wallsNear(kind, x - r, y - r, x + r, y + r).every((s) => segmentDistance(s, x, y) >= r)
const inside = (x: number, y: number) => x > MAP.bounds.minX && x < MAP.bounds.maxX && y > MAP.bounds.minY && y < MAP.bounds.maxY
const nearEdge = (x: number, y: number, m: number) => Math.abs(x) > MAP.bounds.maxX - m || Math.abs(y) > MAP.bounds.maxY - m
const STATION = { x: -493.8, y: 436.9 }, ALTO = { x: -34.4, y: -300.3 }

test("bounds and heightmap cover the play area", () => {
  assert.deepEqual(MAP.bounds, { minX: -959.9, minY: -694.5, maxX: 959.9, maxY: 694.5 })
  const hm = MAP.heightmap
  assert.equal(hm.data.length, hm.cols * hm.rows)
  assert.ok(hm.x0 <= MAP.bounds.minX && hm.x0 + (hm.cols - 1) * hm.cell >= MAP.bounds.maxX)
  assert.ok(hm.y0 <= MAP.bounds.minY && hm.y0 + (hm.rows - 1) * hm.cell >= MAP.bounds.maxY)
  assert.ok(hm.data.every((v) => Number.isInteger(v) && v > 2000 && v < 9000))
})

test("heightAt: station on the valley floor, Monzone Alto on its spur", () => {
  const station = heightAt(STATION.x, STATION.y), alto = heightAt(ALTO.x, ALTO.y)
  assert.ok(station > 205 && station < 225, `station ${station}`)
  assert.ok(alto > 270 && alto < 310, `alto ${alto}`)
  assert.equal(heightAt(-1e6, -1e6), heightAt(MAP.bounds.minX, MAP.bounds.minY)) // clamped
})

test("player spawn and parked cars are inside the bounds, clear of walls and off traffic lanes", () => {
  const spots = [MAP.spawns.player, ...MAP.spawns.parked]
  assert.ok(MAP.spawns.parked.length >= 60 && MAP.spawns.parked.length <= 120, `${MAP.spawns.parked.length} parked`)
  for (const s of spots) {
    assert.ok(inside(s.x, s.y), JSON.stringify(s))
    assert.ok(clear("walk", s.x, s.y, 1.2) && clear("drive", s.x, s.y, 1.2), JSON.stringify(s))
  }
  assert.ok(hypot(MAP.spawns.player.x + 414.4, MAP.spawns.player.y - 433.1) < 40, "player near the Carabinieri")
  const lanes = graph.trafficEdges.map((e) => {
    const { a, b, road } = graph.edges[e]!
    return { ax: graph.nodes[a]!.x, ay: graph.nodes[a]!.y, bx: graph.nodes[b]!.x, by: graph.nodes[b]!.y, half: MAP.roads[road]!.w / 2 }
  })
  for (const p of MAP.spawns.parked) {
    const c = Ops.cos(p.angle), s = Ops.sin(p.angle)
    for (const [u, v] of [[0, 0], [1.85, 0.85], [1.85, -0.85], [-1.85, 0.85], [-1.85, -0.85]] as const) {
      const x = p.x + c * u - s * v, y = p.y + s * u + c * v
      for (const l of lanes) assert.ok(segmentDistance(l, x, y) >= l.half - 0.05, `parked ${JSON.stringify(p)} on a lane`)
    }
  }
})

test("walls: none on a road; only buildings and barriers come inside w/2", () => {
  assert.ok(MAP.walls.walk.length > 0 && MAP.walls.drive.length > 0)
  const near = (x: number, y: number, ring: ReadonlyArray<number>, d: number) => inRing(x, y, ring) || segsOf(ring, true).some((s) => segmentDistance(s, x, y) < d)
  const fixed = (s: Segment) => {
    const on = (x: number, y: number) => MAP.buildings.some((b) => near(x, y, b.outer, 0.35)) || MAP.barriers.some((b) => segsOf(b.pts).some((q) => segmentDistance(q, x, y) < 0.05))
    return on(s.ax, s.ay) && on(s.bx, s.by)
  }
  for (const r of MAP.roads) {
    if (r.tunnel === true) continue
    for (const { x, y } of samples(r.pts, 2)) {
      if (nearEdge(x, y, 10)) continue // road-exit caps
      const where = `${r.cls} ${r.id} at ${x.toFixed(1)},${y.toFixed(1)}`
      assert.ok(clear("walk", x, y, Math.min(0.6, r.w / 2)), `walk wall on ${where}`)
      if (isDrivable(r.cls)) assert.ok(clear("drive", x, y, 1), `drive wall within 1 m of ${where}`)
      const h = r.w / 2 - 0.05
      for (const kind of isDrivable(r.cls) ? (["walk", "drive"] as const) : (["walk"] as const))
        for (const s of wallsNear(kind, x - h, y - h, x + h, y + h)) if (segmentDistance(s, x, y) < h) assert.ok(fixed(s), `terrain/trunk ${kind} wall inside w/2 of ${where}`)
    }
  }
})

test("building interiors are closed: walking or driving in from the nearest road stops at the outline", () => {
  const roads = MAP.roads.flatMap((r) => segsOf(r.pts))
  for (const b of MAP.buildings) {
    const xs = b.outer.filter((_, i) => i % 2 === 0), ys = b.outer.filter((_, i) => i % 2 === 1)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    // Only roads within the 40 m search radius of the footprint can matter (same order, same ties).
    const centrelines = roads.filter((s) =>
      Math.max(s.ax, s.bx) >= x0 - 40 && Math.min(s.ax, s.bx) <= x1 + 40 && Math.max(s.ay, s.by) >= y0 - 40 && Math.min(s.ay, s.by) <= y1 + 40)
    // Interior target: the grid point deepest inside the footprint, away from any lane through it.
    let tx = 0, ty = 0, depth = 0
    for (let x = x0; x <= x1; x += 0.5) for (let y = y0; y <= y1; y += 0.5) {
      if (!inRing(x, y, b.outer) || (b.holes ?? []).some((h) => inRing(x, y, h)) || centrelines.some((s) => segmentDistance(s, x, y) < 2)) continue
      const d = Math.min(...segsOf(b.outer, true).map((s) => segmentDistance(s, x, y)))
      if (d > depth) [tx, ty, depth] = [x, y, d]
    }
    if (depth < 0.8) continue
    let sx = 0, sy = 0, best = 40
    for (const s of centrelines) for (let t = 0; t <= 1; t += 0.05) {
      const x = s.ax + (s.bx - s.ax) * t, y = s.ay + (s.by - s.ay) * t, d = hypot(x - tx, y - ty)
      if (d < best && !inRing(x, y, b.outer)) [sx, sy, best] = [x, y, d]
    }
    if (best >= 40) continue
    for (const [kind, r] of [["walk", 0.35], ["drive", 0.9]] as const) {
      let p = { x: sx, y: sy }
      for (let step = 0; step < 400; step++) {
        const dx = tx - p.x, dy = ty - p.y, d = hypot(dx, dy)
        if (d < 0.05) break
        const k = Math.min(1, 0.25 / d), q = moveCircles(p, [{ x: 0, y: 0 }], { x: dx * k, y: dy * k }, r, wallsNear(kind, p.x - 2, p.y - 2, p.x + 2, p.y + 2))
        if (hypot(q.position.x - p.x, q.position.y - p.y) < 1e-3) break
        p = q.position
      }
      assert.ok(hypot(p.x - tx, p.y - ty) > 0.5, `${kind} gets inside building ${b.id} at ${tx},${ty}`)
    }
  }
})

test("traffic graph: one component reaching the station and Monzone Alto, edges clear of walls, exits inside the caps", () => {
  const chord = (e: number): Segment => {
    const { a, b } = graph.edges[e]!
    return { ax: graph.nodes[a]!.x, ay: graph.nodes[a]!.y, bx: graph.nodes[b]!.x, by: graph.nodes[b]!.y }
  }
  const near = (p: { x: number; y: number }, r: number) => graph.trafficEdges.some((e) => segmentDistance(chord(e), p.x, p.y) < r)
  assert.ok(near(STATION, 30) && near(ALTO, 60))
  const traffic = new Set(graph.trafficEdges)
  const seen = new Set([graph.edges[graph.trafficEdges[0]!]!.a])
  for (const stack = [...seen]; stack.length > 0;) for (const e of graph.adjacency[stack.pop()!]!) {
    if (!traffic.has(e)) continue
    for (const n of [graph.edges[e]!.a, graph.edges[e]!.b]) if (!seen.has(n)) {
      seen.add(n)
      stack.push(n)
    }
  }
  assert.ok(graph.trafficEdges.every((e) => seen.has(graph.edges[e]!.a) && seen.has(graph.edges[e]!.b)), "traffic is connected")
  assert.ok(graph.edges.every((e) => e.length > 0 && e.length <= 25.5 && e.road < MAP.roads.length))
  assert.ok(graph.walkEdges.length > graph.trafficEdges.length)
  for (const e of graph.trafficEdges) for (const { x, y } of samples([chord(e).ax, chord(e).ay, chord(e).bx, chord(e).by], 1))
    assert.ok(clear("drive", x, y, 1), `traffic edge ${e} within 1 m of a drive wall at ${x.toFixed(1)},${y.toFixed(1)}`)
  graph.nodes.forEach((n, i) => {
    const degree = graph.adjacency[i]!.filter((e) => traffic.has(e)).length
    assert.ok(degree !== 1 || clear("drive", n.x, n.y, 2.3), `a car at traffic dead end ${i} (${n.x},${n.y}) touches a wall`)
  })
})

test("profiles: class grades (1.5x relaxed at most), deck and underpass clearances, no perched water", () => {
  // 1.5 x the class limit, plus slack where two junction pins conflict (a straight line between them).
  const limit: Record<string, number> = { tertiary: 0.16, unclassified: 0.24, residential: 0.24, service: 0.31, track: 0.31, rail: 0.0425 }
  for (const r of [...MAP.roads, ...MAP.rail.map((q) => ({ ...q, cls: "rail" }))]) {
    const max = limit[r.cls]
    if (max === undefined) continue
    const s = [0]
    for (let i = 1; i < r.z.length; i++) s.push(s[i - 1]! + hypot(r.pts[2 * i]! - r.pts[2 * i - 2]!, r.pts[2 * i + 1]! - r.pts[2 * i - 1]!))
    for (let i = 0; i < r.z.length; i++) for (let j = i + 1; j < r.z.length; j++) if (s[j]! - s[i]! >= 8) {
      const g = Math.abs(r.z[j]! - r.z[i]!) / (s[j]! - s[i]!)
      assert.ok(g <= max, `${r.cls} ${r.id} grade ${(g * 100).toFixed(1)}% at ${r.pts[2 * i]},${r.pts[2 * i + 1]}`)
      break
    }
  }
  const decks = [...MAP.roads.filter((r) => r.bridge === true), ...MAP.rail.filter((r) => r.bridge === true)]
  for (const w of MAP.water) for (const d of decks) for (const c of crossings(w.pts, d.pts)) {
    const gap = zAt(d.z, c.j, c.u) - zAt(w.z, c.i, c.t)
    assert.ok(gap >= 2.4, `bridge ${d.id} only ${gap.toFixed(1)} m over water ${w.id}`)
  }
  for (const rl of MAP.rail) for (const rd of MAP.roads) if (rl.bridge === true || rd.tunnel === true) for (const c of crossings(rl.pts, rd.pts)) {
    const gap = zAt(rl.z, c.i, c.t) - zAt(rd.z, c.j, c.u)
    assert.ok(gap >= 4.6, `rail ${rl.id} only ${gap.toFixed(1)} m over road ${rd.id}`)
  }
  for (const w of MAP.water) for (let i = 0; i < w.z.length; i++) {
    const x = w.pts[2 * i]!, y = w.pts[2 * i + 1]!
    const joins = MAP.water.some((o) => o.w > w.w && segsOf(o.pts).some((s) => segmentDistance(s, x, y) < o.w / 2 + 1))
    if (!joins) assert.ok(w.z[i]! - heightAt(x, y) <= 2.5, `water ${w.id} perched ${(w.z[i]! - heightAt(x, y)).toFixed(1)} m at ${x},${y}`)
  }
})

test("road names, classes, styles, area kinds and districts", () => {
  const labels = new Set(MAP.roads.flatMap((r) => [r.name, r.ref]))
  for (const name of ["SP59", "SP10", "Via Riolo", "Via delle Cave", "Via Cesare Battisti"]) assert.ok(labels.has(name), name)
  assert.ok(MAP.roads.every((r) => (ROAD_CLASSES as ReadonlyArray<string>).includes(r.cls) && r.z.length * 2 === r.pts.length))
  assert.ok(MAP.buildings.every((b) => (BUILDING_STYLES as ReadonlyArray<string>).includes(b.style) && b.tint >= 0 && b.tint <= 3 && b.h >= 2.5 && b.h <= 22))
  assert.ok(MAP.areas.every((a) => isAreaKind(a.kind)), "every area kind is one of AREA_KINDS")
  const names = new Set(MAP.districts.map((d) => d.name))
  for (const name of ["Monzone (Stazione)", "Monzone Alto", "Santa Lucia", "Torrignana", "Aiola", "Castello di Aiola", "Novicchia", "Acquanera"]) assert.ok(names.has(name), name)
  const centres = MAP.buildings.map((b) => {
    const n = b.outer.length / 2
    return { x: b.outer.filter((_, i) => i % 2 === 0).reduce((a, v) => a + v, 0) / n, y: b.outer.filter((_, i) => i % 2 === 1).reduce((a, v) => a + v, 0) / n }
  })
  const covered = centres.filter((c) => MAP.districts.some((d) => hypot(c.x - d.x, c.y - d.y) <= d.r)).length
  assert.ok(covered >= 0.85 * centres.length, `${covered}/${centres.length} buildings inside a district disc`)
  assert.equal(districtAt(STATION.x, STATION.y).name, "Monzone (Stazione)")
  assert.equal(districtAt(ALTO.x, ALTO.y).name, "Monzone Alto")
  assert.ok(MAP.districts.includes(districtAt(MAP.bounds.maxX, MAP.bounds.minY))) // far corner: nearest rim
})
