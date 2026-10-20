/**
 * Web Audio plumbing the vehicle synths share: moving params, building a voice from its first
 * params, freeing a voice's graph, and one-shots rendered ahead with an OfflineAudioContext once
 * per context. Nothing here touches Web Audio until called, so Node can import it.
 *
 * @module audio/synth/patch
 */
import type { Kit, Voice, VoiceFactory, VoiceIo } from "../types.ts"

/** Time constant (s) for continuous params: about two frames, which removes zipper noise. */
const TAU = 0.05

/** Moves `param` to `value` at `now`: a jump on a voice's first update (no slide-in), a smooth chase after. */
export const glide = (param: AudioParam, value: number, now: number, jump: boolean, tau = TAU): void => {
  if (jump) param.setValueAtTime(value, now)
  else param.setTargetAtTime(value, now, tau)
}

/** A voice whose nodes are built on its first update, from those params (a vehicle model fixes the graph). */
export const builtOnFirst = <P>(build: (io: VoiceIo, first: P) => Voice<P>): VoiceFactory<P> => (io) => {
  let voice: Voice<P> | undefined
  return {
    update: (params, now) => (voice ??= build(io, params)).update(params, now),
    stop: (now) => voice?.stop(now)
  }
}

/** Fades `output` to silence from `now` (gone within 6τ ≤ 0.3 s), stops `sources` then and detaches `output` once they end. */
export const fadeOut = (output: GainNode, sources: ReadonlyArray<AudioScheduledSourceNode>, now: number, tau = TAU): void => {
  output.gain.cancelScheduledValues(now)
  output.gain.setTargetAtTime(0, now, tau)
  for (const source of sources) source.stop(now + tau * 6)
  sources[0]!.onended = () => output.disconnect()
}

/** Renders `seconds` of mono sound that `draw` patches into the destination of an offline context at `rate` Hz. */
export const renderOffline = (rate: number, seconds: number, draw: (ctx: OfflineAudioContext) => void): Promise<AudioBuffer> => {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: Math.ceil(rate * seconds), sampleRate: rate })
  draw(ctx)
  return ctx.startRendering()
}

/** Scales `buffer` in place so its peak is `peak`. */
export const normalise = (buffer: AudioBuffer, peak: number): AudioBuffer => {
  const data = buffer.getChannelData(0)
  let max = 0
  for (const v of data) max = Math.max(max, Math.abs(v))
  if (max > 0) for (let i = 0; i < data.length; i++) data[i]! *= peak / max
  return buffer
}

/** Strikes `source` into `out` at `t`: up to `peak` in 3 ms, then an exponential decay with time constant `tau` s. */
export const strike = (ctx: BaseAudioContext, source: AudioNode, out: AudioNode, t: number, peak: number, tau: number): void => {
  const gain = new GainNode(ctx, { gain: 0 })
  source.connect(gain).connect(out)
  gain.gain.setValueAtTime(0, t)
  gain.gain.linearRampToValueAtTime(peak, t + 0.003)
  gain.gain.setTargetAtTime(0, t + 0.003, tau)
}

/** Plays `buffer` into `io.out` at `when` with `gain` and playback `rate`; returns the time it ends. */
export const playBuffer = (io: Omit<VoiceIo, "cents">, buffer: AudioBuffer, gain: number, rate: number, when: number): number => {
  const source = new AudioBufferSourceNode(io.ctx, { buffer, playbackRate: rate }), level = new GainNode(io.ctx, { gain })
  source.connect(level).connect(io.out)
  source.onended = () => level.disconnect()
  source.start(when)
  return when + buffer.duration / rate
}

/** Something a shot renders ahead, cached per context: `prepare` fills it once, `get` is undefined until it resolves. */
export const rendered = <T>(make: (ctx: BaseAudioContext, kit: Kit) => Promise<T>) => {
  const cache = new WeakMap<BaseAudioContext, T>()
  return {
    prepare: async (ctx: BaseAudioContext, kit: Kit): Promise<void> => {
      if (!cache.has(ctx)) cache.set(ctx, await make(ctx, kit))
    },
    get: (ctx: BaseAudioContext): T | undefined => cache.get(ctx)
  }
}

/** One of `items`, at random. */
export const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(Math.random() * items.length)]!
