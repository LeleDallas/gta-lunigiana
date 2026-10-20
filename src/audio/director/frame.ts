/**
 * One frame of the director, shared by its vehicle, people and world parts: the listener's ears
 * and surroundings, the way from any source to them (`path`, its obstacles cached per key), and
 * the frame's requests. One-shots play at once, loud ones with their echoes off the slopes;
 * continuous voices are offered (`hold`) and `commit` keeps the loudest of each kind up to its cap.
 *
 * @module audio/director/frame
 */
import type { VehicleModel } from "../../sim/vehicles.ts"
import { airCutoff, audibility, type Cabin, CABIN, dbToGain, SPEED_OF_SOUND, spreading } from "../acoustics.ts"
import type { Echo } from "../places.ts"
import type { Continuous, Heard, OneShot, Placement, Speaker } from "../types.ts"
import { type Ears, hear, type Hearing, SILENT, type Source } from "./hearing.ts"
import { CAPS, ECHO, echoes, KEEP_DB, LEVELS, type Level } from "./levels.ts"
import type { Between, Occluder } from "./occluder.ts"

/** How a path is heard: Doppler-shifted (vehicles), `share` of the listener's cabin in the way (1; 0.5 for their own horn), `quiet` dB under the nominal peak. */
export interface Way { readonly doppler?: boolean; readonly share?: number; readonly quiet?: number }

/** What the director's parts see and do this frame. */
export interface Frame {
  readonly heard: Heard
  /** Speaker time, s, and the time since the last frame (0 while the audio is off or paused). */
  readonly now: number
  readonly dt: number
  readonly ears: Ears
  /** The model of the vehicle the listener sits in. */
  readonly inside: VehicleModel | undefined
  /** The masking floor at the ears, dB(A), and how enclosed they are (0…1). */
  readonly ambient: number
  readonly street: number
  readonly random: () => number
  /** How `source` reaches the ears; `key` caches its obstacles (none for sounds of the listener's own car or body). */
  readonly path: (key: string | undefined, source: Source, level: Level, way?: Way) => Hearing
  /** Offers continuous voice `key` this frame (ignored when inaudible). */
  readonly hold: (key: string, sound: Continuous, at: Hearing) => void
  /** Plays a one-shot `after` s past its travel time (ignored when inaudible). */
  readonly play: (sound: OneShot, at: Hearing, after?: number) => void
}

/** A continuous voice offered this frame. */
export interface Offer { readonly key: string; readonly sound: Continuous; readonly at: Hearing }

/** Everything a frame is made from. */
export interface Setup {
  readonly heard: Heard
  readonly now: number
  readonly dt: number
  /** The audio context exists: before, nothing is measured or played (state is still tracked). */
  readonly live: boolean
  readonly ears: Ears
  readonly inside: VehicleModel | undefined
  readonly ambient: number
  readonly street: number
  readonly random: () => number
  readonly occluder: Occluder
  readonly echoes: ReadonlyArray<Echo>
  readonly speaker: Speaker
  /** Filled by `hold`, for `commit`. */
  readonly offers: Array<Offer>
}

/** Nothing in the way (sounds of the listener's own car or body). */
const CLEAR: Between = { delta: 0, forest: 0 }

/** A placement Web Audio accepts: a non-finite one would mute its kind for the session. */
const finite = (p: Placement): boolean => Number.isFinite(p.gain + p.pan + p.cutoff + p.cents + p.wet)

/** `share` of `cabin`'s insertion loss, its lowpass opening up log-wise as the share falls. */
const scaled = (cabin: Cabin, share: number): Cabin => (share === 1 ? cabin : { loss: cabin.loss * share, cutoff: 20000 * (cabin.cutoff / 20000) ** share })

/** This frame's view and requests. */
export const makeFrame = (setup: Setup): Frame => {
  const { ears, inside, ambient, street, speaker, occluder, now } = setup
  const cabin = inside === undefined ? undefined : CABIN[inside]
  const play = (sound: OneShot, at: Hearing, after = 0) => {
    const delay = at.delay + after
    if (!at.audible || !finite(at.placement) || !Number.isFinite(delay)) return
    speaker.play(sound, at.placement, delay)
    if (!echoes(sound)) return
    for (const echo of setup.echoes) {
      // The echo's extra way past the direct sound, never closer than `minLoss` under it.
      const extra = Math.max(ECHO.minLoss, echo.loss - spreading(at.r, LEVELS[sound.kind].rMin))
      if (audibility(at.level - extra, ambient) === 0) continue
      const placement = {
        gain: at.placement.gain * dbToGain(-extra),
        pan: echo.pan,
        cutoff: Math.min(at.placement.cutoff, airCutoff(echo.delay * SPEED_OF_SOUND)),
        cents: 0,
        wet: at.placement.wet * ECHO.wet
      }
      if (finite(placement)) speaker.play(sound, placement, delay + echo.delay)
    }
  }
  return {
    heard: setup.heard,
    now,
    dt: setup.dt,
    ears,
    inside,
    ambient,
    street,
    random: setup.random,
    path: (key, source, level, way = {}) => {
      if (!setup.live) return SILENT
      const through = cabin === undefined ? undefined : scaled(cabin, way.share ?? 1)
      // Obstacles only take away: a source masked even in the clear is not worth measuring.
      const r = Math.hypot(source.x - ears.x, source.y - ears.y, source.z - ears.z)
      if (audibility(level.db - (way.quiet ?? 0) - spreading(r, level.rMin) - (through?.loss ?? 0), ambient) === 0) return SILENT
      const between = key === undefined ? CLEAR : occluder.between(key, ears, source, now)
      return hear({
        ears, source, db: level.db, rMin: level.rMin, quiet: way.quiet, delta: between.delta, forest: between.forest, ambient, street,
        cabin: through, doppler: way.doppler
      })
    },
    hold: (key, sound, at) => {
      if (at.audible && finite(at.placement)) setup.offers.push({ key, sound, at })
    },
    play
  }
}

/** Holds the loudest offers of each kind up to its cap, those `kept` from last frame counting `KEEP_DB` louder; returns the keys held. */
export const commit = (offers: ReadonlyArray<Offer>, speaker: Speaker, kept: ReadonlySet<string>): Set<string> => {
  const rank = (offer: Offer) => offer.at.level + (kept.has(offer.key) ? KEEP_DB : 0)
  const counts = new Map<Continuous["kind"], number>(), held = new Set<string>()
  for (const { key, sound, at } of [...offers].sort((a, b) => rank(b) - rank(a))) {
    const n = (counts.get(sound.kind) ?? 0) + 1
    counts.set(sound.kind, n)
    if (n > CAPS[sound.kind]) continue
    speaker.hold(key, sound, at.placement)
    held.add(key)
  }
  return held
}
