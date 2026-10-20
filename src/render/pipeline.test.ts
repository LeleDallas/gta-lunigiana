import assert from "node:assert/strict"
import { test } from "node:test"

import { Vector3 } from "three"

import { SCREEN_RIGHT, SCREEN_UP } from "../sim/view.ts"
import { isoCamera, zoomFor } from "./pipeline.ts"

test("the camera's screen axes are the sim's SCREEN_RIGHT and SCREEN_UP on the ground", () => {
  const { right, up } = isoCamera()
  // three (x, z) = sim (x, −y)
  assert.ok(Math.abs(right.x - SCREEN_RIGHT.x) < 1e-9 && Math.abs(-right.z - SCREEN_RIGHT.y) < 1e-9 && Math.abs(right.y) < 1e-9)
  const ground = new Vector3(up.x, 0, up.z).normalize()
  assert.ok(Math.abs(ground.x - SCREEN_UP.x) < 1e-9 && Math.abs(-ground.z - SCREEN_UP.y) < 1e-9)
})

test("ground axes project as exact 2:1 pixel lines", () => {
  const { right, up } = isoCamera()
  for (const axis of [new Vector3(1, 0, 0), new Vector3(0, 0, 1)]) {
    assert.ok(Math.abs(Math.abs(axis.dot(up) / axis.dot(right)) - 0.5) < 1e-9)
  }
})

test("the driving zoom widens above 16 m/s and narrows again only below 13 m/s", () => {
  assert.equal(zoomFor(undefined, 5), 8)
  assert.equal(zoomFor(15, 8), 6, "just got in at town speed")
  assert.equal(zoomFor(17, 6), 5)
  assert.equal(zoomFor(-14, 5), 5, "slowing through the band keeps the wide view")
  assert.equal(zoomFor(12, 5), 6)
  assert.equal(zoomFor(15, 6), 6)
})
