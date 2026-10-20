import assert from "node:assert/strict"
import { test } from "node:test"

import { CABIN, ENGINES, engineTargets } from "./engine.ts"

const at = (rpm: number, rpmN: number, load: number) => ({ rpm, rpmN, load, shifted: false })
const db = (a: number, b: number) => 20 * Math.log10(a / b)

test("the firing frequency follows revs and firing pulses per revolution", () => {
  assert.equal(engineTargets(ENGINES.panda, at(6000, 1, 1), false).hz, 200)
  assert.equal(engineTargets(ENGINES.ape, at(6000, 1, 1), false).hz, 100)
  assert.equal(engineTargets(ENGINES.truck, at(2000, 1, 1), false).hz, 100)
})

test("idle is 11 dB under full load at the redline in gain, overrun in between, and darker", () => {
  const full = engineTargets(ENGINES.panda, at(6200, 1, 1), false), idle = engineTargets(ENGINES.panda, at(800, 0, 0), false)
  const overrun = engineTargets(ENGINES.panda, at(6200, 1, 0), false)
  assert.ok(Math.abs(db(idle.gain, full.gain) + 11) < 1e-9)
  assert.ok(overrun.gain > idle.gain && overrun.gain < full.gain)
  assert.ok(idle.lowpass < overrun.lowpass && overrun.lowpass < full.lowpass)
})

test("the driver's seat dulls the own engine behind the firewall and leaves its level to the director", () => {
  const outside = engineTargets(ENGINES.carabinieri, at(3000, 0.4, 0.5), false), inside = engineTargets(ENGINES.carabinieri, at(3000, 0.4, 0.5), true)
  assert.equal(inside.gain, outside.gain)
  assert.deepEqual([inside.cabinHz, inside.shelf, outside.cabinHz, outside.shelf], [CABIN.lowpass, CABIN.shelf, 20000, 0])
})

test("every model peaks at the same nominal level at the redline under full load (the director sets each model's loudness)", () => {
  for (const spec of Object.values(ENGINES)) assert.equal(engineTargets(spec, at(6000, 1, 1), false).gain, 0.5 * spec.trim)
})

test("only turbo models whine, and only under load", () => {
  assert.equal(engineTargets(ENGINES.panda, at(6000, 1, 1), false).turbo, 0)
  assert.equal(engineTargets(ENGINES.truck, at(2000, 1, 0), false).turbo, 0)
  assert.ok(engineTargets(ENGINES.truck, at(2000, 1, 1), false).turbo > 0)
})
