import assert from "node:assert/strict"
import { test } from "node:test"

import { MAP } from "../sim/map/index.ts"
import { SPEED_OF_SOUND } from "./acoustics.ts"
import { ambienceAt, bells, birdSpot, dogsNear, echoesAt, forestAlong, streetAt, surfaceAt, wallAt } from "./places.ts"

/** A small deterministic random source, so the checks never flake. */
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const FOREST = { x: 500, y: -400 }, MEADOW = { x: -329, y: 1078 }, GRAGNOLA = { x: -1751.2, y: 3360.4 }, EQUI = { x: 1804.9, y: 721 }

test("surfaces: road carriageways by their OSM surface, the forest floor, a meadow", () => {
  // Midway along the longest segment of the first road of each surface, away from any junction.
  const cases = [["tertiary", "asphalt", "asphalt"], ["path", "paving_stones", "stone"], ["track", "unpaved", "dirt"], ["track", "gravel", "gravel"]] as const
  for (const [cls, surface, expected] of cases) {
    const { pts } = MAP.roads.find((r) => r.cls === cls && r.surface === surface && r.tunnel !== true && r.bridge !== true)!
    const length = (i: number) => Math.hypot(pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!)
    let k = 0
    for (let i = 0; i + 3 < pts.length; i += 2) if (length(i) > length(k)) k = i
    assert.equal(surfaceAt((pts[k]! + pts[k + 2]!) / 2, (pts[k + 1]! + pts[k + 3]!) / 2), expected, surface)
  }
  assert.equal(surfaceAt(FOREST.x, FOREST.y), "leaves")
  assert.equal(surfaceAt(MEADOW.x, MEADOW.y), "grass")
})

test("walls: a tree trunk, buildings by kind and style, the guard rail, the stone wall and a cliff, each 0.3 m off; bare ground is earth", () => {
  /** 0.3 m off the middle of the longest edge of `pts`, on its right (outside a counter-clockwise ring). */
  const beside = (pts: ReadonlyArray<number>, closed: boolean) => {
    let best = { x: 0, y: 0, length: 0 }
    for (let i = closed ? 0 : 2, n = pts.length, j = closed ? n - 2 : 0; i < n; j = i, i += 2) {
      const ex = pts[i]! - pts[j]!, ey = pts[i + 1]! - pts[j + 1]!, length = Math.hypot(ex, ey)
      if (length > best.length) best = { x: (pts[i]! + pts[j]!) / 2 + (0.3 * ey) / length, y: (pts[i + 1]! + pts[j + 1]!) / 2 - (0.3 * ex) / length, length }
    }
    return best
  }
  const buildings = [
    ["house", "stone", "stone"], ["house", "plaster", "masonry"], ["church", "church", "stone"], ["ruins", "ruin", "stone"],
    ["greenhouse", "industrial", "glass"], ["industrial", "industrial", "sheet"], ["substation", "industrial", "sheet"]
  ] as const
  for (const [kind, style, expected] of buildings) {
    const at = beside(MAP.buildings.find((b) => b.kind === kind && b.style === style)!.outer, true)
    assert.equal(wallAt(at.x, at.y), expected, `${kind}/${style}`)
  }
  for (const [kind, expected] of [["guard_rail", "rail"], ["wall", "stone"], ["cliff", "rock"]] as const) {
    const at = beside(MAP.barriers.find((b) => b.kind === kind)!.pts, false)
    assert.equal(wallAt(at.x, at.y), expected, kind)
  }
  const { trees } = MAP
  assert.equal(wallAt(trees[0]! + 0.55, trees[1]!), "tree")
  assert.equal(wallAt(MEADOW.x, MEADOW.y), "earth")
})

test("ambience shares stay within 1 and tell the forest, the meadow and the village apart", () => {
  for (let x = MAP.bounds.minX; x <= MAP.bounds.maxX; x += 97) for (let y = MAP.bounds.minY; y <= MAP.bounds.maxY; y += 89) {
    const { forest, open, built } = ambienceAt(x, y)
    assert.ok(Math.min(forest, open, built) >= 0 && forest + open + built <= 1 + 1e-6, `${x}, ${y}`)
  }
  assert.ok(ambienceAt(FOREST.x, FOREST.y).forest > 0.9)
  assert.ok(ambienceAt(MEADOW.x, MEADOW.y).open > 0.9)
  assert.ok(ambienceAt(GRAGNOLA.x, GRAGNOLA.y).built > 0.9)
})

test("streets: Gragnola's centre is enclosed, a meadow is open; the forest lines a path through it", () => {
  assert.ok(streetAt(GRAGNOLA.x, GRAGNOLA.y) > 0.5)
  assert.equal(streetAt(MEADOW.x, MEADOW.y), 0)
  assert.ok(Math.abs(forestAlong(FOREST.x, FOREST.y, FOREST.x + 40, FOREST.y) - 40) < 1e-9)
  assert.equal(forestAlong(MEADOW.x, MEADOW.y, MEADOW.x + 40, MEADOW.y), 0)
})

test("echoes at Equi Terme come off the slopes around it, finite and in range; none on the open meadow", () => {
  const echoes = echoesAt(EQUI.x, EQUI.y)
  assert.ok(echoes.length >= 1 && echoes.length <= 2)
  for (const { delay, loss, pan } of echoes) {
    assert.ok(delay >= 80 / SPEED_OF_SOUND && delay <= 800 / SPEED_OF_SOUND, `${delay} s`)
    assert.ok(Number.isFinite(loss) && loss > 40 && Math.abs(pan) <= 0.85)
  }
  assert.deepEqual(echoesAt(MEADOW.x, MEADOW.y), [])
})

test("one bell per settlement, lower in taller towers", () => {
  assert.ok(bells.length >= 8)
  assert.equal(new Set(bells.map((b) => b.key)).size, bells.length)
  for (const b of bells) assert.ok(b.pitch >= 400 && b.pitch <= 800, b.key)
  // The map's tallest building, Monzone Alto's 30 m church tower, hangs the deepest bell.
  const alto = bells.find((b) => Math.hypot(b.x - 6, b.y + 326) < 5)
  assert.ok(alto !== undefined && alto.pitch === 400 && alto.z > 325)
})

test("dogs are stable picks out in the farms; birds sing from a nearby tree, never on a treeless meadow", () => {
  const all = dogsNear(0, 0, 1e6)
  assert.ok(all.length > 50)
  assert.deepEqual(dogsNear(0, 0, 1e6), all)
  assert.ok(dogsNear(-400, 400, 300).every((d) => Math.hypot(d.x + 400, d.y - 400) <= 300))
  const random = seeded(3)
  for (let k = 0; k < 20; k++) {
    const spot = birdSpot(FOREST.x, FOREST.y, random)
    assert.ok(spot !== undefined)
    const d = Math.hypot(spot.x - FOREST.x, spot.y - FOREST.y)
    assert.ok(d >= 15 && d <= 70, `${d} m`)
  }
  assert.equal(birdSpot(MEADOW.x, MEADOW.y, random), undefined)
})
