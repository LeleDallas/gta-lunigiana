/**
 * The master bus: every emitter's dry signal and the shared reverb's return meet in a master gain,
 * then a limiter (its makeup gain trimmed off), an analyser (the output level, for browser checks)
 * and the speakers. The reverb is two convolvers with generated impulse responses, an open
 * valley's long faint tail and a stone street's short dense one, crossfaded by how enclosed the
 * listener is.
 *
 * @module audio/mixer
 */
import { impulseResponse } from "./buffers.ts"
import type { Bus } from "./emitter.ts"
import type { Room } from "./types.ts"

/** The mix the emitters play into. */
export interface Mixer extends Bus {
  /** Crossfades the reverb towards `room` from `now`. */
  readonly room: (room: Room, now: number) => void
  /** The output's RMS level over the last ~43 ms, dBFS (`SILENCE_DB` when silent). */
  readonly level: () => number
}

/** The floor `level` reports for silence, dBFS. */
export const SILENCE_DB = -100

const MASTER = 0.8
/** A gentle limiter rather than the squashing defaults (synthesis.md §1.1, physics.md §9). */
const LIMITER = { threshold: -6, knee: 6, ratio: 12, attack: 0.003, release: 0.25 } as const
/**
 * The compressor's built-in makeup gain for LIMITER, dB (spec: (1 / curve(1))^0.6; measured 2.14 in
 * Chrome; re-measure when LIMITER changes). Trimmed off after it, so quiet mixes keep MASTER and a
 * +14 dBFS overload peaks near +1 dBFS instead of +2.8.
 */
const MAKEUP_DB = 2.14
/** Impulse responses: length, RT60 and pre-delay, s. */
const VALLEY = { seconds: 2.6, rt60: 2, preDelay: 0.03 } as const
const STREET = { seconds: 1.2, rt60: 0.9, preDelay: 0.01 } as const
/** A fully wet send returns this many dB below the dry signal. */
const WET_DB = -12
/** The reverb follows the listener's surroundings with this time constant, s (physics.md §7). */
const ROOM_GLIDE = 0.5

/** Equal-power crossfade weights: the valley reverb at `street` 0 (or not a number), the street reverb at 1. */
export const reverbBlend = (street: number): { readonly valley: number; readonly street: number } => {
  // NaN would reach setTargetAtTime and throw on every flush.
  const t = ((Math.min(1, Math.max(0, street)) || 0) * Math.PI) / 2
  return { valley: Math.cos(t), street: Math.sin(t) }
}

/** RMS of `samples` in dBFS, floored at `SILENCE_DB`. */
export const rmsDb = (samples: Float32Array): number => {
  let sum = 0
  for (const v of samples) sum += v * v
  return Math.max(SILENCE_DB, 10 * Math.log10(sum / samples.length))
}

/** The return gain that puts a fully wet send `db` below the dry: the dry pan keeps power, so divide by the IR's energy. */
const returnGain = (ir: AudioBuffer, db: number): number => {
  let energy = 0
  for (let c = 0; c < ir.numberOfChannels; c++) for (const v of ir.getChannelData(c)) energy += v * v
  return 10 ** (db / 20) / Math.sqrt(energy)
}

/** The mix for `ctx`, playing to its destination; the reverb starts in the open valley. */
export const makeMixer = (ctx: BaseAudioContext): Mixer => {
  const master = new GainNode(ctx, { gain: MASTER })
  const analyser = new AnalyserNode(ctx, { fftSize: 2048 })
  master.connect(new DynamicsCompressorNode(ctx, LIMITER)).connect(new GainNode(ctx, { gain: 10 ** (-MAKEUP_DB / 20) })).connect(analyser).connect(ctx.destination)
  const reverb = new GainNode(ctx)
  const tail = (spec: { readonly seconds: number; readonly rt60: number; readonly preDelay: number }) => {
    const buffer = impulseResponse(ctx, spec.seconds, spec.rt60, spec.preDelay)
    // Normalisation would scale each IR by its own rule; returnGain calibrates them instead.
    const back = new GainNode(ctx, { gain: 0 })
    reverb.connect(new ConvolverNode(ctx, { buffer, disableNormalization: true })).connect(back).connect(master)
    return { gain: back.gain, scale: returnGain(buffer, WET_DB) }
  }
  const valley = tail(VALLEY), street = tail(STREET)
  valley.gain.value = valley.scale
  const samples = new Float32Array(analyser.fftSize)
  return {
    dry: master,
    reverb,
    room: (room, now) => {
      const blend = reverbBlend(room.street)
      valley.gain.setTargetAtTime(valley.scale * blend.valley, now, ROOM_GLIDE)
      street.gain.setTargetAtTime(street.scale * blend.street, now, ROOM_GLIDE)
    },
    level: () => {
      analyser.getFloatTimeDomainData(samples)
      return rmsDb(samples)
    }
  }
}
