import assert from "node:assert/strict"
import { test } from "node:test"

import type { VehicleModel } from "../../../sim/vehicles.ts"
import type { Material, Surface, Zone } from "../../types.ts"
import { between } from "./dsp.ts"
import { type Crash, hitOf } from "./hit.ts"
import { crashQuiet } from "./index.ts"
import { tempered } from "./parts.ts"
import { renderCrash } from "./render.ts"
import { bandEnergy, centroidOf, type Features, features, layer, partials } from "./testing.ts"
import { land } from "./textures.ts"

const RATE = 48000
const SEEDS = [1, 2, 3, 4, 5]

/** A small deterministic random source (mulberry32), so the checks never flake. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

interface Spec {
  readonly speed: number
  readonly mass?: number
  readonly model?: VehicleModel
  readonly zone?: Zone
  /** A wall's material, or the model of the car hit (on its rear). */
  readonly against?: Material | VehicleModel
  readonly surface?: Surface
  readonly inside?: boolean
}
const MODELS: ReadonlyArray<string> = ["panda", "ape", "truck", "carabinieri"]
const crash = ({ speed, mass = 1, model = "panda", zone = "front", against = "masonry", surface = "asphalt", inside = false }: Spec): Crash => ({
  kind: "crash", speed, mass, body: { model, zone }, surface, inside,
  against: MODELS.includes(against) ? { kind: "car", body: { model: against as VehicleModel, zone: "rear" } } : { kind: "wall", material: against as Material }
})

/** The design's matrix: a Panda into a house wall from a bump to a hard hit, car–car pairs at their reduced mass, each other target, a side hit, the cabin, a wreck. */
const CASES = {
  bump: { speed: 2 },
  masonry5: { speed: 5 },
  masonry14: { speed: 14 },
  masonry20: { speed: 20 },
  pandas: { speed: 10, mass: 0.5, against: "panda" },
  truck: { speed: 12, mass: 0.8, against: "truck" },
  stone: { speed: 8, mass: 0.6, model: "ape", against: "stone" },
  rail: { speed: 12, mass: 1.3, model: "carabinieri", against: "rail" },
  tree: { speed: 10, against: "tree" },
  earth: { speed: 8, against: "earth", surface: "grass" },
  side: { speed: 12, zone: "side" },
  inside: { speed: 14, inside: true },
  wreck: { speed: 40, mass: 1.3, model: "carabinieri" }
} as const satisfies Record<string, Spec>
type Case = keyof typeof CASES

const renders = new Map<Case, ReadonlyArray<{ readonly x: Float32Array; readonly f: Features }>>()
/** Every seed's render of `name` and its features, made once. */
const of = (name: Case) => {
  let done = renders.get(name)
  if (done === undefined) renders.set(name, (done = SEEDS.map((seed) => {
    const x = renderCrash(crash(CASES[name]), RATE, seeded(seed))
    return { x, f: features(x, RATE) }
  })))
  return done
}
const median = (values: ReadonlyArray<number>): number => [...values].sort((a, b) => a - b)[values.length >> 1]!
/** The median over the seeds of `name` of what `read` takes from a render. */
const med = (name: Case, read: (f: Features) => number) => median(of(name).map(({ f }) => read(f)))
const within = (value: number, lo: number, hi: number, what: string) => assert.ok(value >= lo && value <= hi, `${what}: ${value.toFixed(3)} not in ${lo}…${hi}`)

/** The exterior crashes the critique's acceptance targets apply to (the bump, the rail and the cabin have their own). */
const EXTERIOR = ["masonry5", "masonry14", "masonry20", "pandas", "truck", "stone", "tree", "earth", "side", "wreck"] as const satisfies ReadonlyArray<Case>

test("every render is finite, never over full scale, at most 4 s long and faded to silence", () => {
  for (const name of Object.keys(CASES) as Array<Case>) {
    for (const { x } of of(name)) {
      let peak = 0
      for (const v of x) {
        assert.ok(Number.isFinite(v), name)
        peak = Math.max(peak, Math.abs(v))
      }
      assert.ok(peak > 0.01 && peak <= 1, `${name} peaks at ${peak}`)
      assert.ok(x.length <= 4 * RATE, name)
      assert.ok(Math.abs(x[x.length - 1]!) < 1e-6 && Math.abs(x[x.length - 100]!) < peak * 1e-3, `${name} ends with a click`)
    }
  }
})

test("a seed renders the same crash twice; another seed draws another", () => {
  const a = renderCrash(crash(CASES.masonry14), RATE, seeded(7)), b = renderCrash(crash(CASES.masonry14), RATE, seeded(7)), c = renderCrash(crash(CASES.masonry14), RATE, seeded(8))
  assert.deepEqual(a, b)
  assert.ok(a.length !== c.length || a.some((v, i) => v !== c[i]))
})

test("one level law, ½·μ·v²·(1 − e²): +6.5 dB per doubling of speed, Panda–Panda 3 dB under a Panda into a wall, capped 6 dB over the 15 m/s reference", () => {
  const quiet = (spec: Spec) => crashQuiet(crash(spec))
  assert.ok(Math.abs(quiet({ speed: 15 })) < 0.01)
  for (const v of [2, 4, 8]) within(quiet({ speed: v }) - quiet({ speed: 2 * v }), 5.9, 7, `${v} → ${2 * v} m/s`)
  within(quiet({ speed: 10, mass: 0.5, against: "panda" }) - quiet({ speed: 10 }), 2.9, 3.1, "Panda–Panda")
  assert.equal(quiet({ speed: 30 }), -6)
  assert.equal(quiet({ speed: 60, mass: 1.3, model: "carabinieri" }), -6)
  // The car crushes 30 % of its energy into an earth bank, 60 % into a tree: quieter by that much.
  within(quiet({ speed: 10, against: "earth" }) - quiet({ speed: 10 }), 5, 5.5, "earth")
  within(quiet({ speed: 10, against: "tree" }) - quiet({ speed: 10 }), 2, 2.5, "tree")
  // The renders follow it: the main block's RMS rises with the law.
  const rms = (name: Case) => med(name, (f) => f.rms)
  within(rms("masonry14") - rms("masonry5"), quiet({ speed: 5 }) - quiet({ speed: 14 }) - 2, quiet({ speed: 5 }) - quiet({ speed: 14 }) + 2, "5 → 14 m/s RMS")
})

test("exterior crashes meet the measured targets: a 150–450 ms main block, a 8–25 ms rise, crest 9–15 dB, Gaussian-dense noise, no boom, the energy at 125 Hz–2 kHz", () => {
  for (const name of EXTERIOR) {
    within(med(name, (f) => f.db10 ?? Infinity), 150, 450, `${name} −10 dB, ms`)
    if (name !== "earth") within(med(name, (f) => f.rise), 8, 25, `${name} rise, ms`)
    within(med(name, (f) => f.crest), 9, 15, `${name} crest, dB`)
    for (const p of [1, 2]) within(med(name, (f) => f.phases[p]!.bandFlatness), 0.35, 0.6, `${name} band flatness, phase ${p}`)
    within(med(name, (f) => f.kurtosis), 2.8, 4.5, `${name} 1–8 kHz kurtosis`)
    for (const { f } of of(name)) {
      const octaves = f.phases[1]!.octaves, loudest = octaves.indexOf(0)
      assert.ok(octaves[1]! <= -5, `${name}: 63 Hz at ${octaves[1]} dB`)
      assert.ok(loudest >= 2 && loudest <= 6, `${name}: loudest octave ${loudest}`)
    }
    within(med(name, (f) => f.phases[1]!.octaves[8]!), -25, -12, `${name} 8 kHz, dB`)
    within(med(name, (f) => f.phases[1]!.octaves[9]!), -36, -18, `${name} 16 kHz, dB`)
    // Glass and leaves brighten the tail on purpose.
    for (const p of name === "side" || name === "tree" || name === "masonry20" || name === "wreck" ? [0, 1] : [0, 1, 2]) {
      within(med(name, (f) => f.phases[p]!.centroid), 1500, 3500, `${name} centroid, phase ${p}`)
    }
  }
})

test("the tail grows with speed: −20 dB from 0.25 s to 2.5 s, later the harder the hit", () => {
  const d20 = (name: Case) => med(name, (f) => f.db20 ?? Infinity)
  for (const name of ["masonry5", "masonry14", "masonry20", "wreck"] as const) within(d20(name), 250, 2500, `${name} −20 dB, ms`)
  assert.ok(d20("masonry5") < d20("masonry14") && d20("masonry14") < d20("masonry20") && d20("masonry20") < d20("wreck"))
})

test("the median crash spectrum is flat within 6 dB over 125 Hz–2 kHz", () => {
  for (const name of ["masonry14", "pandas", "truck"] as const) {
    const bands = [2, 3, 4, 5, 6].map((b) => med(name, (f) => f.phases[1]!.octaves[b]!))
    assert.ok(Math.max(...bands) - Math.min(...bands) <= 6, `${name}: ${bands}`)
  }
})

test("a crash has 1–3 long partials: 9 dB clear of the crunch, η 0.001–0.01", () => {
  for (const name of ["masonry5", "masonry14", "pandas", "stone", "tree", "earth"] as const) {
    const counts = of(name).map(({ x, f }) => partials(x, RATE, f.onset).filter((p) => p.eta >= 0.001 && p.eta <= 0.01).length)
    assert.ok(median(counts) >= 1 && Math.max(...counts) <= 8, `${name}: ${counts}`)
  }
})

test("a parking bump is short: −10 dB at 40–100 ms, its crest that of a bumper tap", () => {
  within(med("bump", (f) => f.db10 ?? Infinity), 40, 100, "−10 dB, ms")
  within(med("bump", (f) => f.rise), 8, 25, "rise, ms")
  within(med("bump", (f) => f.crest), 12, 16, "crest, dB")
  within(med("bump", (f) => f.phases[1]!.bandFlatness), 0.35, 0.6, "band flatness")
})

test("the guard rail is the only long tonal ring: low band flatness through 150–600 ms, partials ringing a second and more", () => {
  within(med("rail", (f) => f.phases[2]!.bandFlatness), 0, 0.4, "rail band flatness 150–600 ms")
  assert.ok(med("rail", (f) => f.phases[2]!.bandFlatness) < med("masonry14", (f) => f.phases[2]!.bandFlatness) - 0.15)
  for (const { x, f } of of("rail")) assert.ok(partials(x, RATE, f.onset, 150, 3000).some((p) => p.t60 >= 1), "a partial with T60 ≥ 1 s")
})

test("a tree rustles for more than 2 s; an earth bank is the slowest, dullest hit", () => {
  const rustle = (name: Case) => median(of(name).map(({ x }) => bandEnergy(x, RATE, 2, 2.5, 2500, 8000) / bandEnergy(x, RATE, 0, 0.3, 2500, 8000)))
  assert.ok(10 * Math.log10(rustle("tree")) > -45, `tree rustle ${10 * Math.log10(rustle("tree"))} dB`)
  assert.ok(rustle("tree") > 30 * rustle("masonry14"))
  const others = EXTERIOR.filter((name) => name !== "earth")
  for (const name of others) {
    assert.ok(med("earth", (f) => f.rise) > med(name, (f) => f.rise), `earth rises slower than ${name}`)
    assert.ok(med("earth", (f) => f.phases[1]!.octaves[8]!) < med(name, (f) => f.phases[1]!.octaves[8]!), `earth duller than ${name}`)
  }
})

test("heard from the cabin a crash is boom-heavy: 70–85 % of its energy under 200 Hz", () => {
  within(med("inside", (f) => f.below200), 0.7, 0.85, "inside")
  assert.ok(med("masonry14", (f) => f.below200) < 0.45)
})

test("a tempered pane's shower is centred on the 8 kHz octave, and grass swallows it 14 dB and more", () => {
  const shower = (surface: Surface) => layer(RATE, 2.5, seeded(3), (mix) => tempered(mix, hitOf(crash({ speed: 12, zone: "side", surface }), seeded(4)), 0.02, 0.95))
  const asphalt = shower("asphalt"), grass = shower("grass")
  within(centroidOf(asphalt, RATE, 0.15, 1.4), 6000, 10000, "shower centroid, Hz")
  assert.ok(10 * Math.log10(bandEnergy(grass, RATE, 0.1, 2.4, 20, 20000) / bandEnergy(asphalt, RATE, 0.1, 2.4, 20, 20000)) <= -14)
  // A single piece of debris too.
  const piece = (surface: Surface) => layer(RATE, 1, seeded(5), (mix) => land(mix, 0.1, surface, 0.01, [0, 0, 0, 0, 0.3, 1, 0.6, 0.2, 0, 0], [[between(mix.random, 1000, 2000), 0.01]], 0.5))
  assert.ok(10 * Math.log10(bandEnergy(piece("grass"), RATE, 0, 1, 20, 20000) / bandEnergy(piece("asphalt"), RATE, 0, 1, 20, 20000)) <= -14)
})
