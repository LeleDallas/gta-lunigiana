import assert from "node:assert/strict"
import { test } from "node:test"

import { crashLaw } from "./impacts.ts"

test("crashes pick a tier by speed and grow louder up to full level at 15 m/s, never below the floor", () => {
  assert.deepEqual([1, 5, 12].map((speed) => crashLaw(speed, 1).tier), [0, 1, 2])
  assert.equal(crashLaw(0, 1).gain, 0.1)
  assert.ok(crashLaw(5, 1).gain < crashLaw(10, 1).gain)
  assert.equal(crashLaw(15, 1).gain, 1)
  assert.equal(crashLaw(40, 1).gain, 1)
})

test("heavier masses crash lower, within a bounded rate", () => {
  const rates = [0.01, 0.6, 1, 4, 100].map((mass) => crashLaw(10, mass).rate)
  assert.ok(rates.every((r, i) => i === 0 || r <= rates[i - 1]!))
  assert.equal(crashLaw(10, 1).rate, 1)
  assert.ok(Math.min(...rates) >= 0.8 && Math.max(...rates) <= 1.15)
})
