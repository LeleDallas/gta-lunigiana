/**
 * The crash one-shot: rendered on demand at play from its exact params (render.ts), in pure
 * TypeScript on the main thread. A render is kept per params object, so the director's echoes of one
 * crash (the same object, played again later and fainter) replay it instead of rendering anew.
 * ponytail: main-thread render (a few ms; the heaviest, a wreck, ~10 ms); move it to a Worker if the
 * browser shows long tasks.
 *
 * @module audio/synth/crash
 */
import { bufferOf } from "../../buffers.ts"
import type { Shot } from "../../types.ts"
import { playBuffer } from "../graph.ts"
import { bandLoops } from "./dsp.ts"
import { type Crash, levelOf } from "./hit.ts"
import { renderCrash } from "./render.ts"

/** How far (dB) a crash plays under its nominal peak (the reference crash, a Panda into a house at 15 m/s), so masking counts the level played; negative past it, to −6 dB. */
export const crashQuiet = (sound: Crash): number => -levelOf(sound)

const renders = new WeakMap<Crash, AudioBuffer>()

/** A vehicle hitting a wall, another vehicle or a parked car. */
export const crash: Shot<Crash> = {
  // The noise loops, made once per sample rate, so the first crash renders at its usual cost.
  prepare: (ctx) => Promise.resolve(void bandLoops(ctx.sampleRate)),
  play: (io, sound, when) => {
    let buffer = renders.get(sound)
    if (buffer === undefined) renders.set(sound, (buffer = bufferOf(io.ctx, renderCrash(sound, io.ctx.sampleRate, Math.random))))
    return playBuffer(io, buffer, when)
  }
}
