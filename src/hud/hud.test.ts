import assert from "node:assert/strict"
import { test } from "node:test"

import { Keyboard } from "@typeonce/ritmo-browser"

import { bindings, type PlayerViewModel } from "../sim/index.ts"
import { screenAxes } from "../sim/view.ts"
import { QUARTER } from "../render/pipeline.ts"
import { kmh, pausable, promptText, toggleMapOnKey } from "./hud.ts"
import { minimapRotation } from "./minimap.ts"

const pose = { x: 0, y: 0, angle: 0 }
const view = (patch: Partial<PlayerViewModel>): PlayerViewModel =>
  ({ prev: pose, pose, velocity: { x: 0, y: 0 }, mode: "foot", vehicle: undefined, nearby: undefined, score: { stolen: 0, knocked: 0 }, turns: 0, ...patch })

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

test("the minimap turns screen-up to the top, whichever way the view is turned", () => {
  for (const turns of [0, 1, 2, 3, -1]) {
    // North-up canvas vector of screen-up, rotated by the canvas transform (y grows downwards).
    const { up } = screenAxes(turns), r = minimapRotation(turns * QUARTER)
    const u = up.x, v = -up.y, c = Math.cos(r), s = Math.sin(r)
    assert.ok(Math.abs(u * c - v * s) < 1e-9, `turns ${turns}`)
    assert.ok(Math.abs(u * s + v * c + 1) < 1e-9, `turns ${turns}`)
  }
})

/** A keydown/keyup the way a browser fills it (Node's EventTarget has no KeyboardEvent). */
const keyEvent = (type: string, code: string, key: string, extra: object = {}) =>
  Object.assign(new Event(type), { code, key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra })

test("the M key toggles the map, Esc closes it; repeats, chords and other keys do nothing", () => {
  const host = new EventTarget(), calls: Array<string> = []
  toggleMapOnKey(host, { toggleMap: () => calls.push("toggle"), closeMap: () => calls.push("close") })
  const down = (code: string, key: string, extra: object = {}) => host.dispatchEvent(keyEvent("keydown", code, key, extra))
  down("KeyM", "m")
  down("KeyM", "M") // Shift+M
  down("KeyM", "m", { repeat: true })
  down("KeyM", "m", { metaKey: true })
  down("KeyM", "m", { ctrlKey: true })
  down("KeyM", "µ", { altKey: true })
  down("Semicolon", "m") // AZERTY: the key labelled M
  down("KeyM", ",") // AZERTY: the QWERTY M position types a comma
  down("KeyM", "ь") // Cyrillic: no Latin letter, so the position counts
  down("Escape", "Escape")
  down("KeyW", "w")
  assert.deepEqual(calls, ["toggle", "toggle", "toggle", "toggle", "close"])
})

// Regression: keys tapped while the map was open queued up and acted on resume (F stole a car).
test("pausing for the map drops taps made on it, keeps held keys held, and skips the sim", () => {
  const host = new EventTarget()
  const keyboard = Keyboard.actions(host as unknown as Window, bindings)
  let open = false, ticks = 0
  const update = pausable(() => open, keyboard, () => ++ticks, -1)
  host.dispatchEvent(keyEvent("keydown", "KeyW", "w"))
  open = true
  host.dispatchEvent(keyEvent("keydown", "KeyF", "f"))
  host.dispatchEvent(keyEvent("keyup", "KeyF", "f"))
  assert.equal(update(), -1)
  assert.equal(ticks, 0)
  open = false
  assert.equal(update(), 1)
  const now = keyboard.snapshot()
  assert.equal(now.action.pressed, false, "the F tapped on the map does not steal a car on resume")
  assert.equal(now.up.held, true, "W held through the pause is still held")
})
