import assert from "node:assert/strict"
import { test } from "node:test"

import { MAP } from "../sim/map/index.ts"
import { groundY, ROAD_LIFT, terrainY, yOf } from "./ground.ts"

const hm = MAP.heightmap

test("terrainY hits the heightmap nodes (row 0 = south) and stays planar inside a triangle", () => {
  for (const [i, j] of [[0, 0], [10, 3], [200, 100], [479, 347], [300, 340]] as const) {
    assert.ok(Math.abs(terrainY(hm.x0 + i * hm.cell, hm.y0 + j * hm.cell) - yOf(hm.data[j * hm.cols + i]! / 10)) < 1e-6)
  }
  // South-east triangle of cell (100, 100): the centroid is the mean of its corners.
  const x = hm.x0 + 100 * hm.cell, y = hm.y0 + 100 * hm.cell, node = (i: number, j: number) => yOf(hm.data[j * hm.cols + i]! / 10)
  const mean = (node(100, 100) + node(101, 100) + node(101, 101)) / 3
  assert.ok(Math.abs(terrainY(x + (2 / 3) * hm.cell, y + (1 / 3) * hm.cell) - mean) < 1e-6)
})

test("groundY stands on a bridge deck from above and on the river bank from below", () => {
  const bridge = MAP.roads.find((r) => r.bridge === true && r.cls === "tertiary")!
  const x = (bridge.pts[0]! + bridge.pts[2]!) / 2, y = (bridge.pts[1]! + bridge.pts[3]!) / 2
  const deck = yOf((bridge.z[0]! + bridge.z[1]!) / 2) + ROAD_LIFT.tertiary
  assert.ok(Math.abs(groundY(x, y) - deck) < 0.5, "no previous height: the highest surface, the deck")
  assert.ok(Math.abs(groundY(x, y, deck - 0.2) - deck) < 0.5, "already on the deck: stays there")
  assert.equal(groundY(x, y, terrainY(x, y)), terrainY(x, y), "under the bridge: stays on the ground")
  assert.ok(deck - terrainY(x, y) > 2)
})

test("groundY stands on an at-grade road when arriving from the terrain beside it", () => {
  const road = MAP.roads.find((r) => r.bridge !== true && r.tunnel !== true && r.cls === "tertiary")!
  const x = (road.pts[0]! + road.pts[2]!) / 2, y = (road.pts[1]! + road.pts[3]!) / 2
  assert.ok(groundY(x, y) > terrainY(x, y), "the road surface floats above the terrain")
  assert.equal(groundY(x, y, terrainY(x, y)), groundY(x, y))
  assert.equal(groundY(-388.6, 429.6, terrainY(-388.6, 429.6)), groundY(-388.6, 429.6), "the reviewer's sunk player")
})
