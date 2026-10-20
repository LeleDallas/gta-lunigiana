/**
 * Vehicle impacts and handling sounds (synthesis.md §4, §6). The fixed ones are rendered once per
 * context with an OfflineAudioContext and normalised; playing one costs a buffer source and a gain.
 *
 * - `crash`: three tiers by impact speed × three variants. Light: a 90→38 Hz thump, a low body
 *   thud and trim rattling; medium adds the metal crunch and ringing panels (free-free bar modes
 *   1 : 2.756 : 5.404 : 8.933); heavy adds breaking glass. Loudness follows (speed / 15)^1.2, and
 *   heavier masses play slower, so lower.
 * - `thud`: a vehicle hitting a person, kept tasteful: a low thump and a cloth swish, no crunch.
 * - `door`: per model open (two latch clicks, the seal) and close (thump, latch, panel ring).
 * - `ignition`: the starter whirring with a dip at every compression, then the engine catching:
 *   the real engine synth flaring and settling, fading as the running engine voice takes over.
 * - `scrape` (a voice): metal grinding along a wall, ringing panels and grit, louder with speed.
 *
 * @module audio/synth/impacts
 */
import { VEHICLE_MODELS, type VehicleModel } from "../../sim/vehicles.ts"
import { loop } from "../buffers.ts"
import type { Continuous, Kit, OneShot, Shot, VoiceFactory } from "../types.ts"
import { engine, ENGINES } from "./engine.ts"
import { fadeOut, glide, normalise, pick, playBuffer, renderOffline, rendered, strike } from "./patch.ts"

/** Free-free bar mode ratios: the panels' inharmonic ring. */
const BAR = [1, 2.756, 5.404, 8.933] as const

/** How heavy each crash tier's render is: light, medium, heavy. */
const TIERS = [0.15, 0.55, 1] as const
const VARIANTS = 3

/** The crash law: the tier (light below 4 m/s, heavy from 10), the gain (a floor keeps bumps audible), the playback rate (heavier is lower). */
export const crashLaw = (speed: number, mass: number): { readonly tier: number; readonly gain: number; readonly rate: number } => ({
  tier: speed < 4 ? 0 : speed < 10 ? 1 : 2,
  gain: Math.max(0.1, Math.min(1, (Math.max(0, speed) / 15) ** 1.2)),
  rate: Math.min(1.15, Math.max(0.8, Math.max(0.05, mass) ** -0.12))
})

/** A noise source (fresh offset per render) through a filter, ready to strike. */
const filtered = (ctx: BaseAudioContext, buffer: AudioBuffer, options: BiquadFilterOptions): AudioNode => loop(ctx, buffer).connect(new BiquadFilterNode(ctx, options))

/** A sine sweeping from `from` to `to` Hz over `seconds`. */
const sweep = (ctx: BaseAudioContext, from: number, to: number, seconds: number): OscillatorNode => {
  const osc = new OscillatorNode(ctx, { frequency: from })
  osc.frequency.setValueAtTime(from, 0)
  osc.frequency.exponentialRampToValueAtTime(to, seconds)
  osc.start()
  return osc
}

const renderCrash = (rate: number, kit: Kit, heavy: number) => renderOffline(rate, 0.6 + heavy * 1.2, (ctx) => {
  const out = ctx.destination
  strike(ctx, sweep(ctx, 90, 38, 0.12), out, 0, 0.9, 0.06)
  strike(ctx, filtered(ctx, kit.brown, { type: "lowpass", frequency: 250 }), out, 0, 0.8, 0.05)
  for (let i = 0; i < 8; i++) {
    strike(ctx, filtered(ctx, kit.white, { type: "bandpass", frequency: 2000 + 2500 * Math.random(), Q: 4 }), out, 0.01 + 0.2 * Math.random() ** 2, 0.15, 0.004)
  }
  if (heavy > 0.25) {
    strike(ctx, filtered(ctx, kit.white, { type: "bandpass", frequency: 1400 + 1200 * heavy, Q: 0.9 }), out, 0.005, 0.6 * heavy, 0.04 + 0.09 * heavy)
    const f0 = 140 + Math.random() * 160
    BAR.forEach((ratio, i) => {
      const panel = new OscillatorNode(ctx, { frequency: f0 * ratio * (0.98 + 0.04 * Math.random()) })
      panel.start()
      strike(ctx, panel, out, 0.004, [0.3, 0.2, 0.12, 0.07][i]! * heavy, [0.22, 0.15, 0.1, 0.06][i]! * (0.5 + heavy))
    })
  }
  if (heavy > 0.6) for (let i = 0; i < 25; i++) {
    const t = 0.01 + 0.4 * Math.random() ** 2, glass = new OscillatorNode(ctx, { frequency: 2000 + 5000 * Math.random() })
    glass.start(t)
    strike(ctx, glass, out, t, 0.03 + 0.05 * Math.random(), 0.008 + 0.04 * Math.random())
  }
})

const crashes = rendered((ctx, kit) => Promise.all(TIERS.map((heavy) => Promise.all(
  Array.from({ length: VARIANTS }, () => renderCrash(ctx.sampleRate, kit, heavy).then((b) => normalise(b, 0.5)))
))))

/** A vehicle hitting a wall, another vehicle or a parked car. */
export const crash: Shot<Extract<OneShot, { readonly kind: "crash" }>> = {
  prepare: crashes.prepare,
  play: (io, sound, when) => {
    const tiers = crashes.get(io.ctx)
    if (!tiers) return when
    const law = crashLaw(sound.speed, sound.mass)
    return playBuffer(io, pick(tiers[law.tier]!), law.gain, law.rate * (0.94 + 0.12 * Math.random()), when)
  }
}

const renderThud = (rate: number, kit: Kit) => renderOffline(rate, 0.4, (ctx) => {
  const out = ctx.destination
  strike(ctx, sweep(ctx, 120, 60, 0.08), out, 0, 0.9, 0.04)
  strike(ctx, filtered(ctx, kit.brown, { type: "lowpass", frequency: 400 }), out, 0, 0.7, 0.025)
  strike(ctx, filtered(ctx, kit.white, { type: "bandpass", frequency: 2000, Q: 1.5 }), out, 0.004, 0.15, 0.008)
})

const thuds = rendered((ctx, kit) => Promise.all(Array.from({ length: VARIANTS }, () => renderThud(ctx.sampleRate, kit).then((b) => normalise(b, 0.5)))))

/** A body hit by a vehicle: full level from 12 m/s. */
export const thud: Shot<Extract<OneShot, { readonly kind: "thud" }>> = {
  prepare: thuds.prepare,
  play: (io, sound, when) => {
    const variants = thuds.get(io.ctx)
    return variants ? playBuffer(io, pick(variants), Math.max(0.15, Math.min(1, sound.speed / 12)), 0.9 + 0.2 * Math.random(), when) : when
  }
}

/** One model's door: thump pitch (Hz), panel rings (Hz, decay τ s), and loose-trim rattle level. */
interface DoorSpec {
  readonly thump: number
  readonly rings: ReadonlyArray<readonly [hz: number, tau: number]>
  readonly rattle: number
}

const DOORS = {
  // Light and tinny: a ringing panel.
  panda: { thump: 120, rings: [[600, 0.03]], rattle: 0 },
  // A thin cab door that rattles.
  ape: { thump: 150, rings: [], rattle: 0.5 },
  // Steel cab: two metal rings.
  truck: { thump: 85, rings: [[400, 0.06], [1100, 0.04]], rattle: 0 },
  // Heavy and damped.
  carabinieri: { thump: 70, rings: [], rattle: 0 }
} as const satisfies Record<VehicleModel, DoorSpec>

const renderDoor = (rate: number, kit: Kit, spec: DoorSpec, open: boolean) => renderOffline(rate, open ? 0.25 : 0.45, (ctx) => {
  const out = ctx.destination
  const click = (t: number, frequency: number, peak: number) => strike(ctx, filtered(ctx, kit.white, { type: "bandpass", frequency, Q: 2 }), out, t, peak, 0.0015)
  if (open) {
    click(0, 2500, 0.5)
    click(0.025 + 0.015 * Math.random(), 4000, 0.4)
    strike(ctx, filtered(ctx, kit.brown, { type: "lowpass", frequency: 400 }), out, 0.01, 0.6, 0.008)
    return
  }
  const thump = new OscillatorNode(ctx, { frequency: spec.thump })
  thump.frequency.setTargetAtTime(spec.thump * 0.6, 0, 0.04)
  thump.start()
  strike(ctx, thump, out, 0, 0.9, 0.05)
  strike(ctx, filtered(ctx, kit.brown, { type: "lowpass", frequency: 300 }), out, 0, 0.6, 0.015)
  click(0.012, 3500, 0.3)
  for (const [frequency, tau] of spec.rings) {
    const ring = new OscillatorNode(ctx, { frequency })
    ring.start()
    strike(ctx, ring, out, 0.004, 0.2, tau)
  }
  if (spec.rattle > 0) strike(ctx, filtered(ctx, kit.white, { type: "bandpass", frequency: 1500, Q: 5 }), out, 0.005, spec.rattle, 0.02)
})

const doors = rendered(async (ctx, kit) => {
  const variants = (model: VehicleModel, open: boolean) => Promise.all([0, 1].map(() => renderDoor(ctx.sampleRate, kit, DOORS[model], open).then((b) => normalise(b, open ? 0.3 : 0.5))))
  const sets = await Promise.all(VEHICLE_MODELS.map(async (model) => [model, { open: await variants(model, true), close: await variants(model, false) }] as const))
  return new Map(sets)
})

/** A car door opening or closing. */
export const door: Shot<Extract<OneShot, { readonly kind: "door" }>> = {
  prepare: doors.prepare,
  play: (io, sound, when) => {
    const set = doors.get(io.ctx)?.get(sound.model)
    return set ? playBuffer(io, pick(sound.open ? set.open : set.close), 1, 0.96 + 0.08 * Math.random(), when) : when
  }
}

/**
 * Starter cranking per model: seconds until the engine catches, and the crank speed (rpm). The
 * director starts holding the engine voice about `seconds` after playing `ignition`.
 */
export const CRANK = {
  panda: { seconds: 0.8, rpm: 220 },
  ape: { seconds: 0.4, rpm: 300 },
  truck: { seconds: 1.5, rpm: 180 },
  carabinieri: { seconds: 0.6, rpm: 260 }
} as const satisfies Record<VehicleModel, { readonly seconds: number; readonly rpm: number }>

/** The starter's level against the catch (the model's engine voice at its own nominal level). */
const STARTER = 0.15
/** How long the catch is heard before the running engine voice carries on, s. */
const CATCH = 0.9

const renderIgnition = (rate: number, kit: Kit, model: VehicleModel) => renderOffline(rate, CRANK[model].seconds + CATCH, (ctx) => {
  const out = ctx.destination, crank = CRANK[model], spec = ENGINES[model]
  const starter = new GainNode(ctx, { gain: 0 })
  starter.gain.setValueAtTime(0, 0)
  starter.gain.linearRampToValueAtTime(STARTER, 0.02)
  starter.gain.setValueAtTime(STARTER, crank.seconds)
  starter.gain.setTargetAtTime(0, crank.seconds, 0.02)
  starter.connect(out)
  // The motor's geared whine dips, and the engine lumps, at every compression stroke.
  const motor = new OscillatorNode(ctx, { type: "square", frequency: 140 }), lump = new OscillatorNode(ctx, { frequency: 50 })
  const compression = new OscillatorNode(ctx, { frequency: (crank.rpm / 60) * spec.pulses })
  // Both envelopes stay ≥ 0, so they pulse once per compression (one centred on 0 would ring-modulate at twice the rate).
  const whine = new GainNode(ctx, { gain: 0.6 }), lumps = new GainNode(ctx, { gain: 0.3 })
  motor.frequency.setTargetAtTime(170, 0, 0.15)
  compression.connect(new GainNode(ctx, { gain: 0.4 })).connect(whine.gain)
  compression.connect(new GainNode(ctx, { gain: 0.3 })).connect(lumps.gain)
  motor.connect(new BiquadFilterNode(ctx, { type: "bandpass", frequency: 900, Q: 1 })).connect(whine).connect(starter)
  lump.connect(lumps).connect(starter)
  for (const source of [motor, lump, compression]) source.start()
  // The catch: the engine flares on a blip of throttle and settles toward idle.
  const cents = new ConstantSourceNode(ctx, { offset: 0 }), caught = new GainNode(ctx)
  caught.gain.setTargetAtTime(0, crank.seconds + CATCH * 0.55, 0.12)
  caught.connect(out)
  cents.start()
  const running = engine({ ctx, out: caught, cents, kit })
  for (let t = crank.seconds; t < crank.seconds + CATCH; t += 1 / 60) {
    const since = t - crank.seconds
    running.update({ kind: "engine", model, speed: 0, throttle: since < 0.12 ? 0.7 : 0.7 * Math.exp(-(since - 0.12) / 0.25), inside: false }, t)
  }
})

const ignitions = rendered(async (ctx, kit) => new Map(await Promise.all(
  VEHICLE_MODELS.map(async (model) => [model, normalise(await renderIgnition(ctx.sampleRate, kit, model), 0.4)] as const)
)))

/** The starter until the engine catches (`CRANK` seconds), then the catch fading under the running engine. */
export const ignition: Shot<Extract<OneShot, { readonly kind: "ignition" }>> = {
  prepare: ignitions.prepare,
  play: (io, sound, when) => {
    const buffer = ignitions.get(io.ctx)?.get(sound.model)
    return buffer ? playBuffer(io, buffer, 1, 1, when) : when
  }
}

/** Grinding gain at full speed (12 m/s and up): peaks near 0.5. */
const SCRAPE = 0.5

/** Metal grinding along a wall at `speed` m/s. */
export const scrape: VoiceFactory<Extract<Continuous, { readonly kind: "scrape" }>> = (io) => {
  const { ctx, kit } = io, output = new GainNode(ctx, { gain: 0 }), grind = new GainNode(ctx, { gain: 1 })
  grind.connect(output).connect(io.out)
  const white = loop(ctx, kit.white), band = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 1500, Q: 1.2 })
  white.connect(band).connect(grind)
  // The panels ring: noise exciting a steel sheet's bar modes.
  const modes = BAR.map((ratio, i) => {
    const mode = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 420 * ratio, Q: 30 })
    white.connect(mode).connect(new GainNode(ctx, { gain: [1.5, 1, 0.75, 0.45][i]! })).connect(grind)
    return mode
  })
  const grit = loop(ctx, kit.crackle)
  grit.connect(new BiquadFilterNode(ctx, { type: "highpass", frequency: 2000 })).connect(new GainNode(ctx, { gain: 0.5 })).connect(grind)
  // Stick-slip: the gust signal, sped up 40×, shakes the grinding level at 1–20 Hz.
  const judder = loop(ctx, kit.gust, 40)
  judder.connect(new GainNode(ctx, { gain: 0.5 })).connect(grind.gain)
  // White noise has no pitch to shift: Doppler moves the bands it rings through.
  for (const filter of [band, ...modes]) io.cents.connect(filter.detune)
  io.cents.connect(grit.detune)
  let first = true
  return {
    update: (sound, now) => {
      const speed = Math.min(20, Math.max(0, sound.speed))
      glide(output.gain, SCRAPE * Math.min(1, speed / 12), now, false)
      glide(band.frequency, 1200 + 120 * speed, now, first)
      glide(grit.playbackRate, 0.6 + speed / 8, now, first)
      first = false
    },
    stop: (now) => fadeOut(output, [white, grit, judder], now)
  }
}
