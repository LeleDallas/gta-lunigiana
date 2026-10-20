import assert from "node:assert/strict"
import { test } from "node:test"

import { VEHICLE_MODELS, VEHICLES } from "../sim/vehicles.ts"
import { GEARBOXES, stepGearbox } from "./gearbox.ts"

const DT = 1 / 60

test("a full-throttle run upshifts monotonically, keeps rpm in [idle, redline] and reaches top speed in top gear", () => {
  for (const model of VEHICLE_MODELS) {
    const box = GEARBOXES[model], spec = VEHICLES[model], state = { gear: 0, shiftLeft: 0 }
    let gear = 0, out = stepGearbox(box, state, 0, 1, DT)
    for (let v = 0; v <= spec.maxSpeed; v += spec.accel * DT) {
      out = stepGearbox(box, state, v, 1, DT)
      assert.ok(state.gear >= gear, `${model} hunts at ${v.toFixed(1)} m/s`)
      assert.ok(out.rpm >= box.idle && out.rpm <= box.redline, `${model} rpm ${out.rpm}`)
      gear = state.gear
    }
    assert.equal(state.gear, box.kmhPer1000.length - 1, model)
    assert.ok(out.rpm > 0.75 * box.redline && out.rpm < 0.95 * box.redline, `${model} tops out at ${out.rpm} rpm`)
  }
})

test("no gear hunting at a steady speed and pedal", () => {
  for (const model of VEHICLE_MODELS) {
    const box = GEARBOXES[model]
    for (let v = 0; v <= VEHICLES[model].maxSpeed; v += 0.5) for (const throttle of [0, 0.2, 0.5, 1]) {
      const state = { gear: 0, shiftLeft: 0 }
      for (let i = 0; i < 120; i++) stepGearbox(box, state, v, throttle, DT)
      for (let i = 0; i < 180; i++) assert.equal(stepGearbox(box, state, v, throttle, DT).shifted, false, `${model} at ${v} m/s, throttle ${throttle}`)
    }
  }
})

test("standing still idles, the clutch slips under throttle and a shift cuts the load", () => {
  const box = GEARBOXES.panda, state = { gear: 0, shiftLeft: 0 }
  assert.deepEqual(stepGearbox(box, state, 0, 0, DT), { rpm: 800, rpmN: 0, load: 0, shifted: false })
  assert.equal(stepGearbox(box, state, 0, 1, DT).rpm, box.launch)
  const shift = stepGearbox(box, state, 8, 1, DT)
  assert.ok(shift.shifted && shift.load === 0)
  assert.equal(stepGearbox(box, state, 8, 1, box.shiftS / 2).load, 0)
  assert.equal(stepGearbox(box, state, 8, 1, box.shiftS).load, 1)
})

test("reversing uses first gear and loads the engine; braking does not", () => {
  const box = GEARBOXES.truck, state = { gear: 3, shiftLeft: 0 }
  const back = stepGearbox(box, state, -3, -1, DT)
  assert.equal(state.gear, 0)
  assert.ok(back.rpm > box.idle)
  state.shiftLeft = 0
  assert.equal(stepGearbox(box, state, -3, -1, DT).load, 1)
  assert.equal(stepGearbox(box, state, 10, -1, DT).load, 0)
})
