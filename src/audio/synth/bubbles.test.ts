import assert from "node:assert/strict"
import { test } from "node:test"

import { bubbleTexture, minnaert } from "./bubbles.ts"

/** A small deterministic random source, so the checks never flake. */
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

/** Power of `samples` at `hz` (Goertzel). */
const power = (samples: Float32Array, hz: number, sampleRate: number): number => {
  const c = 2 * Math.cos((2 * Math.PI * hz) / sampleRate)
  let s1 = 0, s2 = 0
  for (const v of samples) [s1, s2] = [v + c * s1 - s2, s1]
  return s1 * s1 + s2 * s2 - c * s1 * s2
}

test("bubbles of one radius ring at the Minnaert frequency 3/r", () => {
  const rate = 16000, r = 0.003, hz = minnaert(r)
  const texture = bubbleTexture(rate, 2, { rate: 200, rMin: r, rMax: r, gamma: 0, xi: 0 }, seeded(11))
  const peak = power(texture, hz, rate)
  for (const other of [0.7, 0.85, 1.2, 1.4]) assert.ok(peak > 20 * power(texture, hz * other, rate), `${hz * other} Hz`)
})

test("a stream texture is RMS-normalised and finite", () => {
  const texture = bubbleTexture(16000, 1, { rate: 800, rMin: 0.0003, rMax: 0.008, gamma: 1.5, xi: 0.1 }, seeded(5))
  const rms = Math.sqrt(texture.reduce((sum, v) => sum + v * v, 0) / texture.length)
  assert.ok(Math.abs(rms - 0.2) < 1e-3)
  assert.ok(texture.every(Number.isFinite))
})
