/**
 * Engine voices (synthesis.md §2.1–2.2): one oscillator at the firing frequency (a sawtooth, or a
 * band-limited pulse for the two-stroke Ape and the diesel), a half-order sub, a tanh waveshaper
 * whose drive follows the load, two exhaust formants, a lowpass opening with revs, and bandpassed
 * noise gated at the firing rate (diesel clatter, two-stroke rattle). Turbo models add a whine that
 * spools up with lag. Each voice owns a virtual gearbox, so revs follow speed and throttle.
 *
 * Levels: every model's output peaks near 0.5 at the redline under full load and sits about 20 dB
 * lower at idle. How loud each model is (physics.md §8) is the director's per-model source level,
 * and so is the own engine's level inside: `inside` only changes the tone (the firewall's dull,
 * boomy filter, physics.md §10).
 *
 * @module audio/synth/engine
 */
import type { VehicleModel } from "../../sim/vehicles.ts"
import { loop, tanhCurve } from "../buffers.ts"
import { GEARBOXES, type GearOutput, type GearState, stepGearbox } from "../gearbox.ts"
import type { Continuous, Voice, VoiceIo } from "../types.ts"
import { builtOnFirst, fadeOut, glide } from "./patch.ts"

type EngineSound = Extract<Continuous, { readonly kind: "engine" }>

/** One engine's timbre (TUNED starting points from synthesis.md §2.2). */
export interface EngineSpec {
  /** Firing pulses per crank revolution: cylinders / 2 for a four-stroke, cylinders for a two-stroke. */
  readonly pulses: number
  /** The firing waveform: a sawtooth, or a pulse with this duty cycle. */
  readonly wave: "sawtooth" | number
  /** Level of the half-order triangle (uneven firing, the two-stroke's "ring-ding"). */
  readonly sub: number
  /** Exhaust resonances: Hz, Q, gain. */
  readonly formants: ReadonlyArray<readonly [hz: number, q: number, gain: number]>
  /** Lowpass at idle and at the redline under load, Hz. */
  readonly lowpass: readonly [idle: number, redline: number]
  /** Highpass, Hz: thins small engines. */
  readonly highpass: number
  /** Extra waveshaper drive at full load. */
  readonly drive: number
  /** Mechanical noise: level, band swept with revs (Hz), Q, and how much the firing pulse gates it. */
  readonly noise: { readonly level: number; readonly band: readonly [number, number]; readonly q: number; readonly pulse: number }
  /** Turbo whine level at full boost; 0 for none. */
  readonly turbo: number
  /** 1 / the patch's own peak near the redline under full load (calibrated by rendering it offline). */
  readonly trim: number
}

/** The engine of every model. */
export const ENGINES = {
  // Fiat Panda 1.2 FIRE, 69 CV: a nasal small four.
  panda: {
    pulses: 2, wave: "sawtooth", sub: 0.25, formants: [[330, 2.5, 0.6], [1100, 3, 0.25]], lowpass: [900, 3800], highpass: 40, drive: 2.5,
    noise: { level: 0.05, band: [700, 2500], q: 1.2, pulse: 0 }, turbo: 0, trim: 0.538
  },
  // Piaggio Ape 50 two-stroke single: thin, buzzy, rattly, no bass.
  ape: {
    pulses: 1, wave: 0.12, sub: 0.12, formants: [[1250, 3, 0.7], [2900, 4, 0.35]], lowpass: [2500, 7500], highpass: 250, drive: 4,
    noise: { level: 0.1, band: [1500, 4500], q: 1, pulse: 0.15 }, turbo: 0, trim: 0.336
  },
  // Marble truck, inline-6 turbo diesel: a low drone with a knock band gated at the firing rate.
  truck: {
    pulses: 3, wave: 0.3, sub: 0.35, formants: [[160, 2, 0.8], [520, 3, 0.35]], lowpass: [350, 1300], highpass: 30, drive: 3,
    noise: { level: 0.06, band: [1500, 2500], q: 1.5, pulse: 0.6 }, turbo: 0.02, trim: 0.435
  },
  // Carabinieri Alfa Romeo Giulia 2.0 turbo, 200 CV: deeper and sportier than the Panda.
  carabinieri: {
    pulses: 2, wave: "sawtooth", sub: 0.3, formants: [[210, 2, 0.8], [780, 2.5, 0.35]], lowpass: [700, 4500], highpass: 35, drive: 3.5,
    noise: { level: 0.04, band: [900, 3500], q: 1, pulse: 0 }, turbo: 0.015, trim: 0.48
  }
} as const satisfies Record<VehicleModel, EngineSpec>

/** The own engine heard from the driver's seat, behind the firewall (physics.md §10). */
export const CABIN = { lowpass: 2500, shelf: 4 } as const

/** Where every param of an engine graph heads for one gearbox step. */
export interface EngineTargets {
  /** Firing frequency, Hz. */
  readonly hz: number
  readonly drive: number
  readonly lowpass: number
  readonly noiseHz: number
  readonly noise: number
  readonly turboHz: number
  readonly turbo: number
  readonly gain: number
  readonly cabinHz: number
  readonly shelf: number
}

/**
 * The output gain at idle against the redline under full load, dB. The lowpass closing and the light
 * drive take about 9 dB more, so idle sits near 20 dB (RMS) below full (offline renders: Panda −19,
 * Ape −25, truck −16, Giulia −22; the diesel's clatter keeps its idle loud).
 */
const IDLE_DB = -11

/** The engine law: revs set pitch and brightness, load sets drive and level (revs weigh 60 % of the level range, load 40 %). */
export const engineTargets = (spec: EngineSpec, gear: GearOutput, inside: boolean): EngineTargets => {
  const { rpm, rpmN, load } = gear
  return {
    hz: (rpm / 60) * spec.pulses,
    drive: 0.4 + load * spec.drive,
    lowpass: spec.lowpass[0] + (spec.lowpass[1] - spec.lowpass[0]) * rpmN * (0.5 + 0.5 * load),
    noiseHz: spec.noise.band[0] + (spec.noise.band[1] - spec.noise.band[0]) * rpmN,
    noise: spec.noise.level * (0.3 + 0.7 * load) * (0.4 + rpmN),
    turboHz: 2500 + 6000 * load * rpmN,
    turbo: spec.turbo * load * rpmN,
    gain: 0.5 * spec.trim * 10 ** ((IDLE_DB * (1 - 0.6 * rpmN - 0.4 * load)) / 20),
    cabinHz: inside ? CABIN.lowpass : 20000,
    shelf: inside ? CABIN.shelf : 0
  }
}

/** A band-limited pulse of duty cycle `duty`: x(t) = Σ 2/(kπ)·sin(kπD)·cos(kωt) (the DC term is dropped). */
const pulseWave = (ctx: BaseAudioContext, duty: number, harmonics = 48): PeriodicWave => {
  const real = new Float32Array(harmonics), imag = new Float32Array(harmonics)
  for (let k = 1; k < harmonics; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty)
  return new PeriodicWave(ctx, { real, imag })
}

/** Turbo spool lag, s. */
const SPOOL = 0.6
/** Longest frame step the gearbox integrates, s (a stalled tab must not jump gears). */
const MAX_DT = 0.1

const build = (io: VoiceIo, first: EngineSound): Voice<EngineSound> => {
  const { ctx } = io, spec: EngineSpec = ENGINES[first.model], box = GEARBOXES[first.model]
  const firing = new ConstantSourceNode(ctx, { offset: 0 })
  const sources: Array<AudioScheduledSourceNode> = [firing]
  const tone = (options: OscillatorOptions, ratio: number) => {
    const osc = new OscillatorNode(ctx, { ...options, frequency: 0 })
    firing.connect(new GainNode(ctx, { gain: ratio })).connect(osc.frequency)
    io.cents.connect(osc.detune)
    sources.push(osc)
    return osc
  }
  // Every layer sums into the cabin filters; the output gain is last, so `stop` detaches the whole voice.
  const cabin = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 20000 })
  const shelf = new BiquadFilterNode(ctx, { type: "lowshelf", frequency: 120, gain: 0 })
  const output = new GainNode(ctx, { gain: 0 })
  cabin.connect(shelf).connect(output).connect(io.out)

  const pre = new GainNode(ctx, { gain: 0.4 }), lowpass = new BiquadFilterNode(ctx, { type: "lowpass", frequency: spec.lowpass[0] })
  const shaper = new WaveShaperNode(ctx, { curve: tanhCurve(), oversample: "2x" })
  const main = tone(spec.wave === "sawtooth" ? { type: "sawtooth" } : { periodicWave: pulseWave(ctx, spec.wave) }, 1)
  main.connect(pre)
  tone({ type: "triangle" }, 0.5).connect(new GainNode(ctx, { gain: spec.sub })).connect(pre)
  pre.connect(shaper).connect(lowpass).connect(new BiquadFilterNode(ctx, { type: "highpass", frequency: spec.highpass })).connect(cabin)
  for (const [frequency, Q, gain] of spec.formants) {
    shaper.connect(new BiquadFilterNode(ctx, { type: "bandpass", frequency, Q })).connect(new GainNode(ctx, { gain })).connect(cabin)
  }

  const hiss = loop(ctx, io.kit.white), band = new BiquadFilterNode(ctx, { type: "bandpass", frequency: spec.noise.band[0], Q: spec.noise.q })
  const hissGain = new GainNode(ctx, { gain: 0 })
  io.cents.connect(hiss.detune)
  hiss.connect(band).connect(hissGain).connect(cabin)
  // Firing-synchronous bursts: the diesel's clatter, the two-stroke's rattle.
  if (spec.noise.pulse > 0) tone({ periodicWave: pulseWave(ctx, 0.1) }, 1).connect(new GainNode(ctx, { gain: spec.noise.pulse })).connect(hissGain.gain)

  const turbo = spec.turbo > 0 ? { whine: new OscillatorNode(ctx, { frequency: 2500 }), gain: new GainNode(ctx, { gain: 0 }) } : undefined
  if (turbo) {
    io.cents.connect(turbo.whine.detune)
    turbo.whine.connect(turbo.gain).connect(cabin)
    sources.push(turbo.whine)
  }
  for (const source of sources) source.start()
  // `loop` started the noise already.
  sources.push(hiss)

  const state: GearState = { gear: 0, shiftLeft: 0 }
  let last: number | undefined
  return {
    update: (sound, now) => {
      const jump = last === undefined
      if (jump) {
        // A voice first heard at speed settles into its gear without a shift's throttle cut.
        stepGearbox(box, state, sound.speed, sound.throttle, 0)
        state.shiftLeft = 0
      }
      const gear = stepGearbox(box, state, sound.speed, sound.throttle, jump ? 0 : Math.min(MAX_DT, Math.max(0, now - last!)))
      last = now
      const t = engineTargets(spec, gear, sound.inside)
      glide(firing.offset, t.hz, now, jump, 0.04)
      glide(pre.gain, t.drive, now, jump, 0.04)
      glide(lowpass.frequency, t.lowpass, now, jump, 0.04)
      glide(band.frequency, t.noiseHz, now, jump)
      glide(hissGain.gain, t.noise, now, jump)
      glide(output.gain, t.gain, now, false, 0.04)
      glide(cabin.frequency, t.cabinHz, now, jump, 0.1)
      glide(shelf.gain, t.shelf, now, jump, 0.1)
      if (turbo) {
        glide(turbo.whine.frequency, t.turboHz, now, false, SPOOL)
        glide(turbo.gain.gain, t.turbo, now, false, SPOOL)
      }
    },
    stop: (now) => fadeOut(output, sources, now)
  }
}

/** An engine: revs from its own gearbox, Doppler from `io.cents`, the cabin tone when `inside`. */
export const engine = builtOnFirst(build)
