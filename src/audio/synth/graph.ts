/**
 * Web Audio building blocks the world synths share: noise bursts and damped pings, a voice's
 * output stage and its retirement, one-shot variants baked offline and cached per context, and
 * playing a baked buffer with a little random variation.
 *
 * Every function builds nodes only when called, so Node can import the synths.
 *
 * @module audio/synth/graph
 */
import type { Kit, VoiceIo } from "../types.ts"

/** Where a one-shot plays: a Shot's io. */
export type ShotIo = Omit<VoiceIo, "cents">

/** A random element of `list`. */
export const pick = <T>(list: ReadonlyArray<T>): T => list[Math.floor(Math.random() * list.length)]!

/** A factor within ±`spread` of 1. */
export const jitter = (spread: number): number => 1 + (Math.random() * 2 - 1) * spread

/** A gain within ±`db` dB of 1. */
export const jitterDb = (db: number): number => 10 ** (((Math.random() * 2 - 1) * db) / 20)

/** `x` clamped to 0…1. */
export const unit = (x: number): number => Math.min(1, Math.max(0, x))

/** Band-passed `noise` at `t`: rises to `peak` in `attack` s, then decays with time constant `tau` s. */
export const burst = (ctx: BaseAudioContext, noise: AudioBuffer, out: AudioNode, t: number, attack: number, tau: number, hz: number, q: number, peak: number): void => {
  const source = new AudioBufferSourceNode(ctx, { buffer: noise }), amp = new GainNode(ctx, { gain: 0 })
  source.connect(new BiquadFilterNode(ctx, { type: "bandpass", frequency: hz, Q: q })).connect(amp).connect(out)
  amp.gain.setValueAtTime(0, t)
  amp.gain.linearRampToValueAtTime(peak, t + attack)
  amp.gain.setTargetAtTime(0, t + attack, tau)
  source.onended = () => amp.disconnect()
  source.start(t, Math.random() * (noise.duration - 1))
  source.stop(t + attack + 9 * tau)
}

/** A sine at `hz` struck at `t` with amplitude `peak`, decaying with time constant `tau` s for `seconds`: thumps, knocks, bell partials. */
export const ping = (ctx: BaseAudioContext, out: AudioNode, t: number, hz: number, peak: number, tau: number, seconds = 9 * tau): void => {
  const tone = new OscillatorNode(ctx, { frequency: hz }), amp = new GainNode(ctx, { gain: 0 })
  tone.connect(amp).connect(out)
  amp.gain.setValueAtTime(peak, t)
  amp.gain.setTargetAtTime(0, t, tau)
  tone.onended = () => amp.disconnect()
  tone.start(t)
  tone.stop(t + seconds)
}

/** A continuous voice's last node: fades in from silence into `out`; `retire` fades it out. */
export const outlet = (ctx: BaseAudioContext, out: AudioNode): GainNode => {
  const level = new GainNode(ctx, { gain: 0 })
  level.gain.setTargetAtTime(1, ctx.currentTime, 0.1)
  level.connect(out)
  return level
}

/** Ends a continuous voice: `level` fades out from `now`, then its `sources` stop and it leaves the emitter. */
export const retire = (level: GainNode, sources: ReadonlyArray<AudioScheduledSourceNode>, now: number): void => {
  level.gain.setTargetAtTime(0, now, 0.05)
  const [first] = sources
  if (first !== undefined) first.onended = () => level.disconnect()
  for (const source of sources) source.stop(now + 0.3)
}

/** The largest absolute sample. */
const peakOf = (samples: Float32Array): number => samples.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0)

/** Scales `sounds` in place by one factor so the loudest of `reference` peaks at `peak`, keeping their relative levels. */
export const normalise = (sounds: ReadonlyArray<Float32Array>, peak: number, reference: ReadonlyArray<Float32Array> = sounds): void => {
  const loudest = Math.max(...reference.map(peakOf))
  if (loudest === 0) return
  for (const samples of sounds) for (let i = 0; i < samples.length; i++) samples[i]! *= peak / loudest
}

/** Renders the mono sound `build` schedules from time 0, `seconds` long at `ctx`'s rate, offline; trailing silence (below −80 dB) is cut. */
export const bake = async (ctx: BaseAudioContext, seconds: number, build: (oc: OfflineAudioContext) => void): Promise<Float32Array<ArrayBuffer>> => {
  // One context per sound: every node runs for its context's whole length, so sharing one would cost count² time.
  const oc = new OfflineAudioContext({ numberOfChannels: 1, length: Math.ceil(seconds * ctx.sampleRate), sampleRate: ctx.sampleRate })
  build(oc)
  const sound = (await oc.startRendering()).getChannelData(0)
  let end = sound.length
  while (end > 1 && Math.abs(sound[end - 1]!) < 1e-4) end--
  return sound.slice(0, end)
}

/** A shot's baked buffers, made once per context: `prepare` bakes them, `get` is undefined until that resolves. */
export const perContext = <T>(make: (ctx: BaseAudioContext, kit: Kit) => Promise<T>) => {
  const jobs = new WeakMap<BaseAudioContext, Promise<void>>(), ready = new WeakMap<BaseAudioContext, T>()
  return {
    prepare: (ctx: BaseAudioContext, kit: Kit): Promise<void> => {
      const job = jobs.get(ctx) ?? make(ctx, kit).then((value) => void ready.set(ctx, value))
      jobs.set(ctx, job)
      return job
    },
    get: (ctx: BaseAudioContext): T | undefined => ready.get(ctx)
  }
}

/** Plays `buffer` into `io.out` at `when`, sped up by `rate` and scaled by `gain`; returns the context time it ends. */
export const playBuffer = (io: ShotIo, buffer: AudioBuffer, when: number, rate = 1, gain = 1): number => {
  const source = new AudioBufferSourceNode(io.ctx, { buffer, playbackRate: rate }), amp = new GainNode(io.ctx, { gain })
  source.connect(amp).connect(io.out)
  source.onended = () => amp.disconnect()
  source.start(when)
  return when + buffer.duration / rate
}
