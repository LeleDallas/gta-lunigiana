/**
 * One source's way to the listener (physics.md §0): every loss in dB, summed and converted once.
 * Spreading, the ground effect, foliage, the worst edge in the way and the listener's cabin set the
 * level at the ears; the masking rule fades and culls it against the ambient floor; air, the edge
 * and the cabin set the lowpass; the motion of both ends sets the Doppler shift; the street around
 * the listener and the distance set the reverb send (none in the open). No map lookups here (the
 * caller measures the ground and the obstacles), so the audition page hears through the same chain.
 *
 * @module audio/director/hearing
 */
import {
  airCutoff, audibility, type Cabin, dbToGain, delayOf, diffraction, doppler, foliageLoss, groundLoss, mixGain, panOf, spreading
} from "../acoustics.ts"
import type { Placement } from "../types.ts"
import { DELAY_FROM, REVERB } from "./levels.ts"

/** The listener's ears (z a.s.l., m) and velocity, m/s. */
export interface Ears { readonly x: number; readonly y: number; readonly z: number; readonly vx: number; readonly vy: number }

/** Where a sound comes from (z a.s.l., m), moving at (vx, vy) m/s. */
export interface Source { readonly x: number; readonly y: number; readonly z: number; readonly vx?: number; readonly vy?: number }

/** Everything about one source's way to the ears. */
export interface Path {
  readonly ears: Ears
  readonly source: Source
  /** dB(A) at 1 m at the synth's nominal peak, and the source's size, m. */
  readonly db: number
  readonly rMin: number
  /** The path's mean height over the ground under it, m (ISO 9613-2's ground effect). */
  readonly height: number
  /** How many dB the synth itself plays under its nominal peak with these params: counts for masking, not for the gain. */
  readonly quiet?: number
  /** Maekawa path difference over the worst edge in the way, m, and metres of forest on the way. */
  readonly delta: number
  readonly forest: number
  /** The masking floor at the ears, dB(A), and how enclosed they are, 0 (open) … 1 (a narrow street). */
  readonly ambient: number
  readonly street: number
  /** The listener's cabin when inside one (scaled already for sounds of their own car). */
  readonly cabin?: Cabin | undefined
  /** Shift the pitch with the motion of both ends (vehicle voices). */
  readonly doppler?: boolean
}

/** How a source reaches the listener. */
export interface Hearing {
  readonly placement: Placement
  /** Level at the ears, dB(A). */
  readonly level: number
  /** Above the hard cull of the masking rule. */
  readonly audible: boolean
  /** Distance, m, and how long a one-shot travels (none inside `DELAY_FROM`), s. */
  readonly r: number
  readonly delay: number
}

/** Nothing reaches the listener. */
export const SILENT: Hearing = { placement: { gain: 0, pan: 0, cutoff: 20000, cents: 0, wet: 0 }, level: -Infinity, audible: false, r: 0, delay: 0 }

/** The acoustic chain of `path`. */
export const hear = (path: Path): Hearing => {
  const { ears, source, cabin } = path
  const dx = source.x - ears.x, dy = source.y - ears.y, r = Math.hypot(dx, dy, source.z - ears.z)
  const edge = diffraction(path.delta)
  const loss = spreading(r, path.rMin) + groundLoss(r, path.height) + foliageLoss(path.forest) + edge.loss + (cabin?.loss ?? 0)
  const level = path.db - (path.quiet ?? 0) - loss
  const fade = audibility(level, path.ambient)
  const reach = Math.min(REVERB.far, Math.max(REVERB.near, r)) / REVERB.ref
  const wet = path.street ** 2 * dbToGain(REVERB.db) * Math.sqrt(reach) * (cabin === undefined ? 1 : REVERB.cabin)
  return {
    placement: {
      gain: mixGain(path.db, loss) * fade,
      pan: panOf(dx, dy),
      cutoff: Math.min(airCutoff(r), edge.cutoff, cabin?.cutoff ?? 20000),
      cents: path.doppler === true ? doppler(source.x, source.y, source.vx ?? 0, source.vy ?? 0, ears.x, ears.y, ears.vx, ears.vy) : 0,
      wet
    },
    level,
    audible: fade > 0,
    r,
    delay: r > DELAY_FROM ? delayOf(r) : 0
  }
}
