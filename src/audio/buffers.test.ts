import assert from "node:assert/strict"
import { test } from "node:test"

import { crackleSamples, gustSamples, noiseSamples, smoothstep } from "./buffers.ts"

/** A small deterministic random source, so the checks never flake. */
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

test("noise loops without a click: the seam step is no bigger than a typical step", () => {
  for (const colour of ["white", "pink", "brown"] as const) {
    const s = noiseSamples(colour, 48000, 48000, seeded(7))
    let sum = 0
    for (let i = 1; i < s.length; i++) sum += Math.abs(s[i]! - s[i - 1]!)
    const typical = sum / (s.length - 1)
    assert.ok(Math.abs(s[0]! - s[s.length - 1]!) < typical * 6, colour)
    assert.ok(s.every((v) => Number.isFinite(v) && Math.abs(v) <= 1.5), colour)
  }
})

test("grains and gusts stay in range", () => {
  assert.ok(crackleSamples(48000, 48000, 400, seeded(3)).some((v) => v !== 0))
  const gust = gustSamples(8000, seeded(5))
  assert.equal(Math.max(...gust.map(Math.abs)), 1)
})

test("smoothstep clamps and eases", () => {
  assert.equal(smoothstep(0, 1, -1), 0)
  assert.equal(smoothstep(0, 1, 2), 1)
  assert.equal(smoothstep(0, 1, 0.5), 0.5)
})
