import assert from "node:assert/strict"
import { test } from "node:test"

import { Vector3 } from "three"

import { screenAxes } from "../sim/view.ts"
import { QUARTER, turnToward, viewAxes, zoomFor } from "./pipeline.ts"

test("at every quarter turn the camera's screen axes are the sim's on the ground, and ground axes project as exact 2:1 pixel lines", () => {
  for (const turns of [0, 1, 2, 3, -1, 6]) {
    const { right, up } = viewAxes(turns * QUARTER), sim = screenAxes(turns)
    // three (x, z) = sim (x, −y)
    assert.ok(Math.abs(right.x - sim.right.x) < 1e-9 && Math.abs(-right.z - sim.right.y) < 1e-9 && Math.abs(right.y) < 1e-9, `right at ${turns}`)
    const ground = new Vector3(up.x, 0, up.z).normalize()
    assert.ok(Math.abs(ground.x - sim.up.x) < 1e-9 && Math.abs(-ground.z - sim.up.y) < 1e-9, `up at ${turns}`)
    for (const axis of [new Vector3(1, 0, 0), new Vector3(0, 0, 1)]) {
      assert.ok(Math.abs(Math.abs(axis.dot(up) / axis.dot(right)) - 0.5) < 1e-9, `2:1 at ${turns}`)
    }
  }
})

test("a quarter turn swings over about a third of a second and stops exactly on its heading, either way", () => {
  for (const [from, to] of [[0, QUARTER], [QUARTER, 0], [-QUARTER, -2 * QUARTER]] as const) {
    let yaw = from, frames = 0
    while (yaw !== to && frames < 60) {
      const next = turnToward(yaw, to, 1 / 60)
      assert.ok(Math.abs(to - next) < Math.abs(to - yaw), "always closer")
      yaw = next
      frames++
    }
    assert.ok(frames >= 15 && frames <= 25, `${from} -> ${to} in ${frames} frames`)
  }
  assert.equal(turnToward(QUARTER, QUARTER, 1 / 60), QUARTER, "at rest it stays put")
})

test("the driving zoom widens above 16 m/s and narrows again only below 13 m/s", () => {
  assert.equal(zoomFor(undefined, 5), 8)
  assert.equal(zoomFor(15, 8), 6, "just got in at town speed")
  assert.equal(zoomFor(17, 6), 5)
  assert.equal(zoomFor(-14, 5), 5, "slowing through the band keeps the wide view")
  assert.equal(zoomFor(12, 5), 6)
  assert.equal(zoomFor(15, 6), 6)
})
