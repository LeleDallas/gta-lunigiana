/**
 * What a crash is before it is heard (physics.md §1–3; critique §4.1, §4.6, §5.2): the energy it
 * dissipates and the one level law that follows from it, how the crush splits between what met, the
 * crush pulse, the main block and its sub-hits, and how long the aftermath lasts. Every random draw of
 * the timing is here; the level depends on the params alone, so masking can count it (`levelOf`).
 *
 * @module audio/synth/crash/hit
 */
import { VEHICLES, type VehicleModel } from "../../../sim/vehicles.ts"
import type { Material, OneShot, Surface, Zone } from "../../types.ts"
import { BODIES, type BodySpec } from "./bodies.ts"
import { between, ramp } from "./dsp.ts"
import { TARGETS } from "./targets.ts"

/** A crash's params. */
export type Crash = Extract<OneShot, { readonly kind: "crash" }>

/** Coefficient of restitution at closing speed `v` m/s: Cipriani 2002's fit to 7 m/s (0.46 at 1 m/s, 0.26 at 5), then 0.1 (physics.md §1.2). */
const restitution = (v: number): number => (v >= 7 ? 0.1 : 0.55605 * Math.exp(-0.198 * v + 0.01533 * v * v - 0.00122 * v ** 3))

/** The reference crash's dissipated energy (a Panda nose-first into masonry at 15 m/s, ½·μ·v²·(1 − e²)): it peaks at the nominal 0.5. */
const REFERENCE = 0.5 * 15 ** 2 * (1 - 0.1 ** 2)
/** Past +6 dB the front is used up: the main block stops growing, and length, sub-hits and debris carry the severity (critique §4.6). */
const CAP_DB = 6
/** The quietest level a crash is rendered at, dB re the reference. */
const FLOOR_DB = -40

/** The car's share of the crush against something of `stiffness` (Infinity: rigid), springs in series: an earth bank takes 70 %, a tree 40 %. */
const shareOf = (car: number, stiffness: number): number => (stiffness === Infinity ? 1 : stiffness / (car + stiffness))

/** ½·μ·v²·(1 − e²) re the reference, times the car's share against a wall: the energy the crunch radiates from. */
const severityOf = (sound: Crash): number => {
  const v = Math.max(0, sound.speed), e = restitution(v), a = BODIES[sound.body.model]
  const share = sound.against.kind === "wall" ? shareOf(a.stiffness, TARGETS[sound.against.material].stiffness) : 1
  return (0.5 * Math.max(0.05, sound.mass) * v * v * (1 - e * e) * share) / REFERENCE
}

/** The crash's level, dB re the reference crash: +6.5 dB per doubling of speed, 10·log10 μ per pair (Panda–Panda −3 dB), capped at +6. */
export const levelOf = (sound: Crash): number => Math.min(CAP_DB, Math.max(FLOOR_DB, 10 * Math.log10(severityOf(sound))))

/** One body as it crushes. */
export interface Crushed {
  readonly model: VehicleModel
  readonly spec: BodySpec
  readonly zone: Zone
  /** Its part of the crunch: all of it against a wall, k_other / (k + k_other) of two cars' (the softer crushes more). */
  readonly part: number
  /** The barrier speed that would crush it as much, m/s: what its damage thresholds read. */
  readonly speed: number
  /** Its velocity change, m/s: what shakes its load loose. */
  readonly dv: number
  /** How long its side of the first contact lasts, s: a PP cover over foam 3–8 ms, bare steel under 1 ms. */
  readonly contact: number
}

/** A secondary contact: when (s), how hard (power re the main block) and how long (s). */
export interface SubHit { readonly at: number; readonly level: number; readonly length: number }

/** Everything the layers render from. */
export interface Hit {
  /** Closing speed, m/s, and the speed a Panda would hit a wall at with the same energy (uncapped: past the level cap, it still lengthens the block and the tail). */
  readonly speed: number
  readonly equivalent: number
  /** The bodies, the listener's (or the striking one) first. */
  readonly bodies: ReadonlyArray<Crushed>
  readonly material: Material | undefined
  /** The crush pulse T, s: densest crunch, its rate falling as cos(πt/T) to maximum crush at T/2. */
  readonly pulse: number
  /** The contact's rise, s, its duration (s: the first event's brightness), and the main block's length (s: within a few dB of its start). */
  readonly rise: number
  readonly contact: number
  readonly block: number
  readonly subHits: ReadonlyArray<SubHit>
  /** How long the aftermath lasts past the block, s, and the whole render (at most 4 s: a struck tree rustles, a guard rail rings on). */
  readonly tail: number
  readonly length: number
  readonly surface: Surface
  readonly inside: boolean
}

/** A body's side of the contact: its bumper on its front and rear, its door skin on a side. */
const contactOf = (spec: BodySpec, zone: Zone, random: () => number): number =>
  zone === "side" ? between(random, 0.0006, 0.0015) : spec.bumper === "plastic" ? between(random, 0.003, 0.008) : between(random, 0.0003, 0.001)

/** The crash `sound` describes, its timing drawn from `random`. */
export const hitOf = (sound: Crash, random: () => number): Hit => {
  const v = Math.max(0, sound.speed), e = restitution(v), mu = Math.min(5, Math.max(0.2, sound.mass))
  const a = BODIES[sound.body.model], target = sound.against.kind === "wall" ? TARGETS[sound.against.material] : undefined
  const other = sound.against.kind === "car" ? sound.against.body : undefined, b = other === undefined ? undefined : BODIES[other.model]
  const kOther = b?.stiffness ?? target!.stiffness
  // The car takes all of a wall's crunch (the wall's share is silent, or its own layer); two cars split it by compliance.
  const parts = b === undefined ? [1] : [b.stiffness / (a.stiffness + b.stiffness), a.stiffness / (a.stiffness + b.stiffness)]
  const crushed = b === undefined ? [shareOf(a.stiffness, kOther)] : parts
  const bodies = [{ ...sound.body, spec: a }, ...(other === undefined || b === undefined ? [] : [{ ...other, spec: b }])].map((body, i): Crushed => {
    const ratio = mu / VEHICLES[body.model].mass
    return {
      model: body.model, spec: body.spec, zone: body.zone, part: parts[i]!,
      speed: v * Math.sqrt(crushed[i]! * ratio), dv: (1 + e) * v * Math.min(1, ratio), contact: contactOf(body.spec, body.zone, random)
    }
  })
  const equivalent = 15 * Math.sqrt(severityOf(sound)), side = bodies.some((body) => body.zone === "side")
  // Springs in series: T = π·√(μ/k) scaled so a Panda into a wall lasts ~0.1 s (barrier pulses 91–106 ms); ±15 % across the pairs.
  const k = kOther === Infinity ? a.stiffness : (a.stiffness * kOther) / (a.stiffness + kOther)
  const pulse = Math.min(0.25, 0.1 * Math.sqrt(mu / k)) * between(random, 0.9, 1.1)
  const crumples = ramp(2.5, 6, equivalent)
  // The main block: a bump is over in 40–100 ms, a crash holds 150–400 ms (rebound, yaw into a second contact, stiff parts ringing).
  const block = Math.max((0.075 + 0.105 * crumples + 0.12 * ramp(6, 30, equivalent)) * (side ? 1.2 : 1) * between(random, 0.85, 1.2), 0.06 + 1.2 * pulse * crumples)
  // 1–3 sub-hits at +50…600 ms, more for side hits and higher speeds; a wreck tumbles on to a second.
  const subHits: Array<SubHit> = []
  if (equivalent >= 4) {
    const count = 1 + Number(random() < 0.3 + 0.3 * Number(side) + 0.3 * ramp(10, 25, equivalent)) + Number(random() < 0.1 + 0.3 * Number(side) + 0.4 * ramp(15, 35, equivalent)) + Number(equivalent > 25)
    for (let i = 0, at = between(random, 0.08, 0.3); i < count && at < (equivalent > 25 ? 1 : 0.6); i++, at += between(random, 0.1, 0.3)) {
      subHits.push({ at, level: between(random, 0.3, 0.8), length: between(random, 0.04, 0.12) })
    }
  }
  const tail = 0.5 + 2 * ramp(3, 30, equivalent)
  const theirs = b === undefined ? between(random, target!.contact[0], target!.contact[1]) : bodies[1]!.contact
  return {
    speed: v, equivalent, bodies, material: sound.against.kind === "wall" ? sound.against.material : undefined, pulse,
    rise: between(random, 0.011, 0.02) * (target?.soft ?? 1) * (side ? 0.9 : 1),
    // Springs in series again: the softer side sets the contact's length; harder hits are a little shorter (Hertz, τ ∝ v^−1/5).
    contact: Math.hypot(bodies[0]!.contact, theirs) * Math.max(0.6, Math.min(1.3, (Math.max(v, 1) / 5) ** -0.2)),
    block, subHits, tail, length: Math.min(4, block + tail + 0.8 + (target?.ringing ?? 0)), surface: sound.surface, inside: sound.inside
  }
}
