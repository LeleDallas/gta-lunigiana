/**
 * What a car hits, by material (synthesis.md §6.4; physics.md §4; critique §5.3, §7): how it takes the
 * crush and what it adds to the car's own sound. Masonry, stone and rock barely radiate (grit, chips,
 * a dull mass); the W-beam guard rail is the only long tonal ring; a sheet-metal wall wobbles; a
 * greenhouse's annealed panes break into ringing shards; an earth bank is a soft, longer, dull pulse;
 * a tree knocks like wood and rustles for seconds. Levels are power re the crunch's main block.
 *
 * @module audio/synth/crash/targets
 */
import { smoothstep } from "../../buffers.ts"
import type { Material } from "../../types.ts"
import { between, type Mix, power, puff, rayleigh, type Spectrum, strike } from "./dsp.ts"
import type { Hit } from "./hit.ts"
import { grains, land, train } from "./textures.ts"

/** One material. */
export interface TargetSpec {
  /** Stiffness re a Panda's front: the car takes k / (k + k_car) of the crush (Infinity: rigid, all of it); a softer contact lasts longer. */
  readonly stiffness: number
  /** How long the car's side of the first contact lasts against it, s (Hertz: steel on steel shortest, wood and soil longest). */
  readonly contact: readonly [number, number]
  /** How much slower the contact builds than against a wall. */
  readonly soft: number
  /** The car's crunch against it, dB per band: a soft bank or a trunk dulls it. */
  readonly tint: Spectrum
  /** How much longer than the car's aftermath it sounds, s (a rail's ring, a tree's rustle, a greenhouse falling). */
  readonly ringing: number
  /** Adds what the struck thing sounds like. */
  readonly add: (mix: Mix, hit: Hit) => void
}

// Spectra, dB per octave band 31.5 Hz … 16 kHz.
/** Plaster and mortar grit, 1.5–6 kHz (STK's CRUNCH1). */
const GRIT = power([-99, -99, -40, -30, -18, -7, 0, -2, -9, -20])
/** Stone grit, brighter (STK's BIGROCKS, a 6.4 kHz resonance). */
const STONE_GRIT = power([-99, -99, -40, -32, -22, -10, -2, 0, -5, -15])
/** A stone landing in gravel: the crunch under its knock. */
const GRAVEL = power([-99, -30, -14, -6, -2, 0, -2, -6, -12, -22])
/** A low rumble of stones and a building's or bank's mass. */
const RUMBLE = power([-8, -3, 0, -4, -12, -22, -32, -99, -99, -99])
/** Dirt thrown up, 1–3 kHz. */
const DIRT = power([-99, -99, -30, -16, -6, 0, -1, -8, -18, -30])
/** Leaves and twigs, 2.5–8 kHz. */
const LEAVES = power([-99, -99, -99, -40, -26, -12, -3, 0, -2, -14])
/** A small hard click (a bolt, a clip, a pebble). */
const CLICK = power([-99, -99, -99, -30, -18, -8, -2, 0, -6, -16])
/** A glass shard's tinkle. */
const SHARD = power([-99, -99, -99, -99, -30, -18, -8, -2, 0, -4])

/** Rigid and massive: no ring, only grit, a few chips and the building's dull mass. */
const masonry = (mix: Mix, hit: Hit): void => {
  const { random } = mix, v = hit.speed, crush = smoothstep(2, 10, v)
  grains(mix, 0.004, 0.7, 2000, 0.12, 0.0008, 0.008 * crush, GRIT)
  grains(mix, 0.1, 1.5, 40, 0.5, 0.001, 0.003 * crush, GRIT)
  // One low, heavily damped mode (40–80 Hz, η 0.1), kept under the crunch: outdoors the boom is weak.
  strike(mix, hit.rise / 2, between(random, 40, 80), 0.1, 0.05)
  // Above ~8 m/s chips fly and land at 0.25–0.75 s: three-mode knocks at 500–2500 Hz (η 0.03).
  for (let i = Math.round(smoothstep(7, 14, v) * between(random, 3, 10)); i > 0; i--) {
    const hz = between(random, 500, 2500)
    land(mix, between(random, 0.25, 0.75), hit.surface, 0.01 * random(), CLICK, [[hz, 0.03], [hz * between(random, 1.5, 2), 0.03], [hz * between(random, 2.4, 3.2), 0.03]], 0.4)
  }
}

/** Rubble stone, dry-stone walls, churches: as masonry with more grit, and above ~8 m/s stones knocked out, thudding and clacking as they land, with a short rumble. */
const stone = (mix: Mix, hit: Hit): void => {
  const { random } = mix, v = hit.speed, crush = smoothstep(2, 10, v)
  grains(mix, 0.004, 0.8, 2500, 0.15, 0.001, 0.01 * crush, STONE_GRIT)
  grains(mix, 0.1, 1.5, 50, 0.5, 0.001, 0.004 * crush, STONE_GRIT)
  strike(mix, hit.rise / 2, between(random, 40, 70), 0.1, 0.05)
  const stones = Math.round(smoothstep(7, 14, v) * between(random, 1, 6))
  for (let i = 0; i < stones; i++) {
    const t = between(random, 0.2, 0.6), hz = between(random, 150, 400)
    land(mix, t, hit.surface, 0.03 * between(random, 0.3, 1), GRAVEL, [[hz, 0.03], [hz * between(random, 1.4, 1.9), 0.03], [between(random, 1000, 3000), 0.02]], 0.6)
  }
  if (stones > 0) puff(mix, 0.15, 0.05, 0.15, 0.03, RUMBLE)
}

/** A cliff: the hardest contact, harsh grit, pebbles trickling down for seconds, almost no ring. */
const rock = (mix: Mix, hit: Hit): void => {
  const { random } = mix
  grains(mix, 0.003, 0.6, 2500, 0.1, 0.0007, 0.01 * smoothstep(2, 10, hit.speed), STONE_GRIT)
  for (let t = between(random, 0.25, 0.5); t < 3; t += -Math.log(1 - random()) / (25 * Math.exp(-t / 0.8) + 0.5)) {
    const hz = between(random, 1200, 4000)
    land(mix, t, hit.surface, 0.004 * Math.exp(-t / 1.2) * random(), CLICK, [[hz, 0.02]], 0.5)
  }
}

/** A steep bank: the bank gives, so the pulse is long and soft; a dull 40–120 Hz thud, dirt sprayed up, clods dropping back. */
const earth = (mix: Mix, hit: Hit): void => {
  const { random } = mix
  puff(mix, 0.005, hit.rise, between(random, 0.05, 0.09), 0.12, RUMBLE)
  strike(mix, hit.rise / 2, between(random, 60, 110), 0.15, 0.1, hit.rise / 2)
  grains(mix, 0.01, 0.9, 1500, 0.3, 0.0015, 0.03, DIRT)
  for (let i = Math.round(between(random, 3, 10)); i > 0; i--) {
    land(mix, between(random, 0.2, 0.5), hit.surface, 0.02 * random(), RUMBLE, [[between(random, 100, 300), 0.1]], 0.4)
  }
}

/** A trunk: a wood knock (Farnell's wood bank 62.5–790 Hz ±10 %, η 0.04–0.06), bark crunch, a creak above ~8 m/s as it bends, leaves and twigs rustling for seconds. */
const tree = (mix: Mix, hit: Hit): void => {
  const { random } = mix, v = hit.speed, at = hit.rise / 2
  const bank = [62.5, 125, 250, 395, 560, 790].map((hz) => hz * between(random, 0.9, 1.1))
  bank.forEach((hz, i) => strike(mix, at, hz, between(random, 0.04, 0.06), (i === 0 ? 0.05 : 0.25) * rayleigh(random) * Math.min(1, v / 6), at))
  if (v > 8) {
    // Stick-slip of the bending trunk through the bank: a burst of creaking 0.1–0.3 s in, for up to a second.
    const from = between(random, 0.1, 0.3)
    train(mix, from, Math.round(between(random, 30, 90) * smoothstep(8, 16, v)), 1 / between(random, 60, 150), 0.4, 0.03, power([-99, -99, -20, -6, 0, -4, -12, -20, -99, -99]), [[bank[3]!, 0.05]], 0.2)
  }
  // The crown shaking: leaves swell in 50–150 ms and rustle 2–4 s, twigs and burrs ticking on the bonnet.
  const from = between(random, 0.05, 0.15), last = between(random, 2, 4)
  puff(mix, from, 0.15, last / 2.5, 0.002 * smoothstep(2, 10, v), LEAVES)
  grains(mix, from, from + last, 1500, last / 2, 0.002, 0.004 * smoothstep(2, 10, v), LEAVES)
  for (let i = Math.round(between(random, 3, 30) * smoothstep(4, 14, v)); i > 0; i--) {
    land(mix, from + between(random, 0.2, last * 0.8), "asphalt", 0.004 * random(), SHARD, [[between(random, 2000, 6000), 0.005]], 0.3)
  }
}

/** The W-beam (3 mm, posts every 2 m), driven while it deflects through the crush pulse: the only long tonal ring of any target, its beam and face bands near 180, 430, 770 Hz and 2–2.7 kHz, each mode with a split partner that beats; T60 1.4–2.4 s (η 0.001–0.003 near 1 kHz; lower modes lose their energy along the beam); a post's dull thud; bolts rattling. */
const rail = (mix: Mix, hit: Hit): void => {
  const { random } = mix, at = hit.rise / 2, drive = Math.min(1, hit.speed / 8), rise = hit.pulse / 2
  const bands = [[160, 210, 4], [400, 470, 4], [730, 810, 3], [1900, 2750, 4], [60, 2600, 4]] as const
  for (const [lo, hi, count] of bands) {
    for (let i = 0; i < count; i++) {
      const hz = lo === 60 ? lo * (hi / lo) ** random() : between(random, lo, hi), eta = Math.max(0.001, 2.2 / (hz * between(random, 1.4, 2.4))), amp = 0.4 * drive * rayleigh(random) * Math.min(1.5, Math.sqrt(hz / 1000))
      strike(mix, 0, hz, eta, amp, rise)
      strike(mix, 0, hz * between(random, 1.002, 1.008), eta, amp * between(random, 0.4, 0.8), rise)
    }
  }
  // The post: free-free bar modes on a heavily damped C section driven into soil.
  const post = between(random, 120, 250)
  for (const ratio of [1, 2.756, 5.404]) strike(mix, at, post * ratio, 0.03, 0.15 * drive / ratio, rise / 2)
  train(mix, between(random, 0.05, 0.15), Math.round(between(random, 6, 16)), 1 / between(random, 20, 40), 0.15, 0.01 * drive, CLICK, [[between(random, 2500, 5000), 0.005]], 0.4)
}

/** A metal-clad industrial wall: a big, wobbly thin-sheet ring (dense low modes beating against near-twins), the sheet clattering on its fixings. */
const sheet = (mix: Mix, hit: Hit): void => {
  const { random } = mix, drive = Math.min(1, hit.speed / 8)
  for (let i = 0; i < 14; i++) {
    const hz = 70 * (1200 / 70) ** random(), eta = between(random, 0.004, 0.01), amp = 0.1 * drive * rayleigh(random) * Math.min(1, Math.sqrt(hz / 300))
    strike(mix, 0, hz, eta, amp, hit.rise)
    strike(mix, 0, hz * between(random, 1.005, 1.02), eta, amp * 0.7, hit.rise)
  }
  train(mix, between(random, 0.04, 0.1), Math.round(between(random, 8, 20)), 1 / between(random, 20, 40), 0.25, 0.02 * drive, CLICK, [[between(random, 900, 2500), 0.01]], 0.5)
}

/** A greenhouse: annealed panes crack and fall as big ringing shards (2–3 modes at 1.6–6 kHz, η 0.002–0.003, ratios {1, 1.5–1.8, 2.2–2.7}) over a longer fall. */
const glass = (mix: Mix, hit: Hit): void => {
  const { random } = mix, v = hit.speed
  puff(mix, 0.002, 0.0004, 0.004, 0.4, SHARD)
  for (let i = Math.round(between(random, 20, 50) * smoothstep(2, 8, v)); i > 0; i--) {
    const t = between(random, 0.1, 0.4) + 1.8 * random() ** 2, hz = between(random, 1600, 6000)
    land(mix, t, hit.surface, 0.02 * Math.exp(-t / 1.5) * random(), SHARD, [[hz, between(random, 0.002, 0.003)], [hz * between(random, 1.5, 1.8), 0.003], [hz * between(random, 2.2, 2.7), 0.003]], 0.5)
  }
  grains(mix, 0.12, 2.2, 400, 0.6, 0.0005, 0.01 * smoothstep(2, 8, v), SHARD)
}

const HARD = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

export const TARGETS = {
  masonry: { stiffness: Infinity, contact: [0.0004, 0.0007], soft: 1, tint: HARD, ringing: 0, add: masonry },
  // A dry-stone wall gives a little.
  stone: { stiffness: 6, contact: [0.0004, 0.0006], soft: 1, tint: HARD, ringing: 0, add: stone },
  sheet: { stiffness: 3, contact: [0.0003, 0.0005], soft: 1, tint: HARD, ringing: 0.5, add: sheet },
  glass: { stiffness: 1, contact: [0.0003, 0.0006], soft: 1.1, tint: HARD, ringing: 1, add: glass },
  // The rail deflects and slides: a longer pulse than a wall's.
  rail: { stiffness: 2, contact: [0.00025, 0.0004], soft: 1.1, tint: HARD, ringing: 1.5, add: rail },
  rock: { stiffness: Infinity, contact: [0.00035, 0.0005], soft: 0.9, tint: HARD, ringing: 1.5, add: rock },
  // The bank gives: the softest, slowest contact, and the dullest crunch (dirt and grass damp the panels too).
  earth: { stiffness: 0.43, contact: [0.005, 0.008], soft: 2.8, tint: [0, 0, 0, 0, -1, -2, -4, -6, -8, -10], ringing: 0, add: earth },
  tree: { stiffness: 1.5, contact: [0.0015, 0.0024], soft: 1.2, tint: [0, 0, 0, 0, 0, -1, -1, -2, -3, -4], ringing: 3, add: tree }
} as const satisfies Record<Material, TargetSpec>
