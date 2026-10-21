/**
 * A virtual gearbox per vehicle model: the simulation only knows speed and throttle, so engine
 * revs come from game-tuned gear tables (km/h per 1000 rpm). Each top gear reaches the model's
 * `VEHICLES` top speed at about 85 % of the redline. Shift points scale with the pedal; a
 * downshift only happens when the lower gear would sit below 90 % of the upshift point, and
 * adjacent gears are closer than the up/down threshold ratio, so the box never hunts at a steady
 * speed. First gear slips the clutch (rpm at least `launch` at full pedal), the throttle is cut
 * while a shift lasts, and reverse uses first gear.
 *
 * @module audio/gearbox
 */
import type { VehicleModel } from "../sim/vehicles.ts"

/** One model's gears and revs. */
interface Gearbox {
  /** Road speed per 1000 rpm in each gear, lowest first. */
  readonly kmhPer1000: ReadonlyArray<number>
  readonly idle: number
  readonly redline: number
  /** Seconds a shift cuts the throttle. */
  readonly shiftS: number
  /** Clutch-slip rpm at full pedal in first gear. */
  readonly launch: number
}

/** A gearbox's live state, mutated in place by `stepGearbox`. */
export interface GearState {
  /** Index into `kmhPer1000`. */
  gear: number
  /** Seconds left in the current shift. */
  shiftLeft: number
}

/** What the engine does this step. */
export interface GearOutput {
  readonly rpm: number
  /** rpm normalised: 0 at idle, 1 at the redline. */
  readonly rpmN: number
  /** Engine load 0…1: the pedal along the motion; 0 while braking or shifting. */
  readonly load: number
}

/** Per-model gear tables (game-tuned, not manufacturer ratios; synthesis.md §2.3). */
export const GEARBOXES = {
  // Fiat Panda 1.2, 5-speed manual: 101 km/h at 5280 rpm in 5th.
  panda: { kmhPer1000: [4.4, 8, 11.6, 15.4, 19.1], idle: 800, redline: 6200, shiftS: 0.35, launch: 2200 },
  // Piaggio Ape 50, 4-speed: 54 km/h at 5780 rpm in 4th.
  ape: { kmhPer1000: [2.28, 3.65, 5.84, 9.34], idle: 1600, redline: 6800, shiftS: 0.4, launch: 3500 },
  // Marble truck, 6-speed diesel: 72 km/h at 1960 rpm in 6th.
  truck: { kmhPer1000: [6.5, 9.2, 13, 18.4, 26, 36.8], idle: 600, redline: 2300, shiftS: 0.5, launch: 1000 },
  // Alfa Romeo Giulia 2.0 turbo, 8-speed automatic: 151 km/h at 5360 rpm in 8th.
  carabinieri: { kmhPer1000: [5.2, 6.62, 8.43, 10.73, 13.66, 17.39, 22.14, 28.2], idle: 750, redline: 6300, shiftS: 0.12, launch: 1800 }
} as const satisfies Record<VehicleModel, Gearbox>

/** Below this speed (m/s) the car counts as standing: the pedal loads the engine either way. */
const STILL = 0.3

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Advances `state` by `dt` seconds at forward `speed` (m/s, negative reversing) and `throttle` in [-1, 1]. */
export const stepGearbox = (gearbox: Gearbox, state: GearState, speed: number, throttle: number, dt: number): GearOutput => {
  const ratios = gearbox.kmhPer1000, top = ratios.length - 1, kmh = Math.abs(speed) * 3.6
  const still = Math.abs(speed) < STILL
  const pedal = Math.min(1, Math.max(0, still ? Math.abs(throttle) : Math.sign(speed) * throttle))
  const rpmIn = (gear: number) => (kmh / ratios[gear]!) * 1000
  const up = lerp(0.5, 0.92, pedal) * gearbox.redline, down = lerp(0.24, 0.42, pedal) * gearbox.redline
  const from = state.gear
  state.shiftLeft = Math.max(0, state.shiftLeft - dt)
  if (speed < -STILL || (still && throttle < 0)) state.gear = 0
  else if (state.shiftLeft === 0) {
    // Loops only settle a fresh state (a voice first heard at speed); in driving one step moves one gear.
    while (state.gear < top && rpmIn(state.gear) > up) state.gear++
    while (state.gear > 0 && rpmIn(state.gear) < down && rpmIn(state.gear - 1) < up * 0.9) state.gear--
  }
  if (state.gear !== from) state.shiftLeft = gearbox.shiftS
  const clutch = state.gear === 0 ? gearbox.idle + pedal * (gearbox.launch - gearbox.idle) : gearbox.idle
  const rpm = Math.min(gearbox.redline, Math.max(rpmIn(state.gear), clutch))
  return { rpm, rpmN: (rpm - gearbox.idle) / (gearbox.redline - gearbox.idle), load: state.shiftLeft > 0 ? 0 : pedal }
}
