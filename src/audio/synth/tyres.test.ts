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

test("heavy tyres are louder and darker", () => {
  const light = tyre(15, 6, "asphalt"), heavy = tyre(15, 6, "asphalt", true)
  assert.ok(heavy.roll > light.roll && heavy.squeal > light.squeal)
  assert.ok(heavy.rollHz < light.rollHz && heavy.pitch < light.pitch)
})
