import assert from "node:assert/strict"
import { test } from "node:test"

import { buildingsIn, heightAt } from "../sim/map/index.ts"
import { pathDifference } from "./occlusion.ts"

/** A point `up` m above the ground at (x, y). */
const at = (x: number, y: number, up = 1.6) => ({ x, y, z: heightAt(x, y) + up })

test("an open, flat meadow hides nothing", () => {
  assert.equal(pathDifference(at(-329, 1078), at(-269, 1078)), 0)
})

test("the 30 m church tower of Monzone Alto shadows the street behind it, but not from above its roof", () => {
  assert.ok(pathDifference(at(-20, -326), at(30, -326)) > 10)
  assert.equal(pathDifference(at(-20, -326, 200), at(30, -326, 200)), 0)
})

test("Monte San Giorgio stands between its two flanks, with no building on the way", () => {
  const west = at(785.7, -563.4), east = at(1185.7, -563.4)
  let buildings = 0
  buildingsIn(west.x, west.y, east.x, east.y, () => buildings++)
  assert.equal(buildings, 0)
  assert.ok(pathDifference(west, east) > 10)
  assert.equal(pathDifference(west, west), 0)
})
