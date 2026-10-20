import assert from "node:assert/strict"
import { test } from "node:test"

import type { PlayerViewModel } from "../sim/index.ts"
import { SCREEN_UP } from "../sim/view.ts"
import { kmh, promptText } from "./hud.ts"
import { MINIMAP_ROTATION } from "./minimap.ts"

const pose = { x: 0, y: 0, angle: 0 }
const view = (patch: Partial<PlayerViewModel>): PlayerViewModel =>
  ({ prev: pose, pose, velocity: { x: 0, y: 0 }, mode: "foot", vehicle: undefined, nearby: undefined, score: { stolen: 0, knocked: 0 }, ...patch })

test("the prompt names the action the key would take", () => {
  assert.equal(promptText(view({})), "")
  assert.equal(promptText(view({ nearby: { label: "Fiat Panda", occupied: false, stolen: false } })), "F — steal Fiat Panda")
  assert.equal(promptText(view({ nearby: { label: "Fiat Panda", occupied: false, stolen: true } })), "F — enter Fiat Panda")
  assert.equal(promptText(view({ nearby: { label: "Piaggio Ape", occupied: true, stolen: false } })), "F — carjack Piaggio Ape")
  assert.equal(promptText(view({ mode: "driving", vehicle: { label: "Fiat Panda", speed: 3 } })), "F — exit")
  assert.equal(promptText(view({ mode: "down", nearby: { label: "Fiat Panda", occupied: false, stolen: false } })), "")
})

test("speed reads in whole km/h, reversing included", () => {
  assert.equal(kmh(10), 36)
  assert.equal(kmh(-2.5), 9)
})

test("the minimap turns SCREEN_UP to the top", () => {
  // North-up canvas vector of SCREEN_UP, rotated by the canvas transform (y grows downwards).
  const u = SCREEN_UP.x, v = -SCREEN_UP.y, c = Math.cos(MINIMAP_ROTATION), s = Math.sin(MINIMAP_ROTATION)
  assert.ok(Math.abs(u * c - v * s) < 1e-9)
  assert.ok(Math.abs(u * s + v * c + 1) < 1e-9)
})
