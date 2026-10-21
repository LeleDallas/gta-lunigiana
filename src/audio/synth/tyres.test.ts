import assert from "node:assert/strict"
import { test } from "node:test"

import type { Surface } from "../types.ts"
import { tyreTargets } from "./tyres.ts"

const tyre = (speed: number, slip: number, surface: Surface, heavy = false) => tyreTargets({ kind: "tyres", speed, slip, surface, heavy })

test("rolling noise rises 30 dB per decade of speed and stops at a standstill", () => {
  assert.ok(Math.abs(20 * Math.log10(tyre(30, 0, "asphalt").roll / tyre(3, 0, "asphalt").roll) - 30) < 1e-9)
  assert.equal(tyre(0, 0, "asphalt").roll, 0)
})

test("a slide squeals on hard ground and sprays gravel on loose ground", () => {
  for (const surface of ["asphalt", "stone"] as const) assert.ok(tyre(15, 6, surface).squeal > tyre(15, 0, surface).squeal, surface)
  for (const surface of ["gravel", "dirt", "grass", "leaves"] as const) {
    assert.equal(tyre(15, 6, surface).squeal, 0, surface)
    assert.ok(tyre(15, 6, surface).crunch > tyre(15, 0, surface).crunch, surface)
  }
  assert.equal(tyre(1.5, 1.5, "asphalt").squeal, 0)
})

test("setts rumble at one per 14 cm, only on stone", () => {
  assert.ok(Math.abs(tyre(14, 0, "stone").settHz - 100) < 1e-9)
  assert.ok(tyre(14, 0, "stone").setts > 0)
  assert.equal(tyre(14, 0, "asphalt").setts, 0)
})

test("the calibration case, the Giulia at top speed with sideways speed 0.3 of it, squeals fully", () => {
  const full = tyre(40, 12, "asphalt")
  assert.equal(full.squeal, tyre(40, 20, "asphalt").squeal)
  assert.ok(tyre(40, 8, "asphalt").squeal < full.squeal)
})

test("heavy tyres are 6 dB louder and darker", () => {
  const light = tyre(15, 6, "asphalt"), heavy = tyre(15, 6, "asphalt", true)
  assert.ok(Math.abs(heavy.roll / light.roll - 2) < 1e-9 && Math.abs(heavy.squeal / light.squeal - 2) < 1e-9)
  assert.ok(heavy.rollHz < light.rollHz && heavy.pitch < light.pitch)
})
