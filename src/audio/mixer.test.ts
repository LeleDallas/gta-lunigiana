import assert from "node:assert/strict"
import { test } from "node:test"

import { reverbBlend, rmsDb, SILENCE_DB } from "./mixer.ts"

test("the reverb crossfade keeps power and clamps the room", () => {
  assert.deepEqual(reverbBlend(-1), { valley: 1, street: 0 })
  // Regression: a NaN room made every flush throw.
  assert.deepEqual(reverbBlend(Number.NaN), { valley: 1, street: 0 })
  assert.ok(Math.abs(reverbBlend(2).street - 1) < 1e-12)
  for (const street of [0.25, 0.5, 0.8]) {
    const { valley, street: alley } = reverbBlend(street)
    assert.ok(Math.abs(valley ** 2 + alley ** 2 - 1) < 1e-12)
  }
})

test("the level reads a full-scale sine at −3 dBFS and silence at the floor", () => {
  const sine = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * i) / 48))
  assert.ok(Math.abs(rmsDb(sine) + 3.0103) < 0.01)
  assert.equal(rmsDb(new Float32Array(2048)), SILENCE_DB)
})
