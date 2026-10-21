import { Ops, Vec2 } from "@typeonce/ritmo-math"

import { forwardSpeed, moveCar, wallsAlong } from "../body.ts"
import { CarInput, Game, Impact, Motion, Pose, Time, Vehicle } from "../schema.ts"
import { VEHICLES, type VehicleSpec } from "../vehicles.ts"

/** Coasting deceleration: rolling (m/s²) plus air drag (1/s × speed). */
const ROLL = 1.5
const AIR = 0.06
/** Handbrake: forward deceleration as a share of `brake`, grip as a share of `grip`, extra yaw. */
const HANDBRAKE_BRAKE = 0.35
const HANDBRAKE_GRIP = 0.2
const HANDBRAKE_YAW = 1.4
/** Wall hits: share of the impact speed bounced back, and speed lost per m/s of impact. */
const BOUNCE = 0.2
const IMPACT_LOSS = 0.04
/** Hits slower than this (m/s) are float noise; how loud a real one sounds is the audio host's call. */
const NOISE = 0.05

/** Forward speed after one step of throttle, brake and drag. */
const longitudinal = (spec: VehicleSpec, v: number, throttle: number, handbrake: boolean, dt: number): number => {
  const toward = (target: number, rate: number) => (v < target ? Math.min(target, v + rate * dt) : Math.max(target, v - rate * dt))
  let next = v
  if (throttle > 0 && v < -0.5) next = toward(0, spec.brake * throttle)
  else if (throttle < 0 && v > 0.5) next = toward(0, spec.brake * -throttle)
  else if (throttle > 0) next = v > spec.maxSpeed ? toward(spec.maxSpeed, ROLL) : toward(spec.maxSpeed, spec.accel * throttle)
  else if (throttle < 0) next = v < -spec.reverseSpeed ? toward(-spec.reverseSpeed, ROLL) : toward(-spec.reverseSpeed, spec.accel * -throttle)
  else next = toward(0, ROLL + AIR * Math.abs(v))
  return handbrake ? next - Math.sign(next) * Math.min(Math.abs(next), spec.brake * HANDBRAKE_BRAKE * dt) : next
}

/** Yaw rate for this steer: full lock only above 6 m/s, reversed when backing up, a little less at top speed. */
const yawRate = (spec: VehicleSpec, v: number, steer: number, handbrake: boolean): number => {
  const speed = Math.abs(v)
  const grip = Math.min(1, speed / 6) * Math.sign(v) / (1 + Math.max(0, speed - 15) * 0.03)
  return steer * spec.turn * grip * (handbrake ? HANDBRAKE_YAW : 1)
}

/**
 * Where a body of `spec` centred on (x, y) at heading `angle` meets what it moves `into` (a unit
 * vector): the centre plus `into` times the body's support distance along it, as a box L×W.
 */
const contact = (spec: VehicleSpec, x: number, y: number, angle: number, into: Vec2.Vec2): Vec2.Vec2 => {
  const fx = Ops.cos(angle), fy = Ops.sin(angle)
  const reach = Math.abs(into.x * fx + into.y * fy) * spec.length / 2 + Math.abs(into.y * fx - into.x * fy) * spec.width / 2
  return { x: x + into.x * reach, y: y + into.y * reach }
}

/**
 * Arcade (GTA2-ish) handling for every vehicle from its CarInput and
 * VEHICLES stats: velocity split into forward and sideways parts, sideways
 * slip dying out with grip (handbrake: drifts), and the body circles swept
 * against drive walls; a hit keeps the sliding part, bounces a little and
 * costs speed by how hard it was. Each hit is an Impact event at the contact point.
 */
export const VehiclePhysics = Game.System("Lunigiana/VehiclePhysics", {
  queries: {
    vehicles: Game.Query({
      selection: { pose: Game.Query.write(Pose), motion: Game.Query.write(Motion), vehicle: Game.Query.read(Vehicle), input: Game.Query.read(CarInput) }
    })
  },
  resources: { time: Game.System.thisTick(Game.System.readResource(Time)) },
  events: { impact: Game.System.writeEvent(Impact) }
}, ({ queries, resources, events }) => {
  const { dt } = resources.time.get()
  if (dt <= 0) return
  for (const { entity, data } of queries.vehicles.each()) {
    const { model } = data.vehicle.get()
    const spec = VEHICLES[model]
    const input = data.input.get()
    const pose = data.pose.get()
    const motion = data.motion.get()
    // Asleep: a parked car nobody touched costs nothing.
    if (input.throttle === 0 && motion.vx === 0 && motion.vy === 0 && motion.spin === 0) continue
    const v0 = forwardSpeed(motion, pose.angle)
    const spin = yawRate(spec, v0, input.steer, input.handbrake)
    const angle = pose.angle + spin * dt
    const fx = Ops.cos(angle), fy = Ops.sin(angle)
    const forward = longitudinal(spec, motion.vx * fx + motion.vy * fy, input.throttle, input.handbrake, dt)
    const lateral = (motion.vy * fx - motion.vx * fy) * Ops.exp(-spec.grip * (input.handbrake ? HANDBRAKE_GRIP : 1) * dt)
    let vx = fx * forward - fy * lateral
    let vy = fy * forward + fx * lateral
    const delta = { x: vx * dt, y: vy * dt }
    const walls = wallsAlong("drive", pose.x, pose.y, delta.x, delta.y, spec.length / 2 + 0.5)
    // A turn that wedges the body into a wall is undone; if moving at all does, the car stays put.
    const turned = moveCar(model, pose, angle, delta, walls)
    const moved = turned ?? moveCar(model, pose, pose.angle, delta, walls)
    if (moved === undefined) {
      const speed = Math.sqrt(vx * vx + vy * vy)
      if (speed > NOISE) {
        const at = contact(spec, pose.x, pose.y, pose.angle, { x: vx / speed, y: vy / speed })
        events.impact.emit({ hit: "wall", x: at.x, y: at.y, speed, mass: spec.mass, car: entity.id })
      }
      data.motion.set({ vx: 0, vy: 0, spin: 0 })
      continue
    }
    let nextSpin = turned === undefined ? 0 : spin
    if (moved.blocked) {
      const real = Vec2.scale(Vec2.subtract(moved.position, pose), 1 / dt)
      const lost = Vec2.subtract({ x: vx, y: vy }, real)
      const impact = Vec2.length(lost)
      const into = Vec2.normalizeOr(lost, Vec2.zero)
      if (impact > NOISE) {
        const at = contact(spec, moved.position.x, moved.position.y, turned === undefined ? pose.angle : angle, into)
        events.impact.emit({ hit: "wall", x: at.x, y: at.y, speed: impact, mass: spec.mass, car: entity.id })
      }
      const keep = Math.max(0.2, 1 - IMPACT_LOSS * impact)
      // Never faster than before the hit (push-outs from a rotation can add speed).
      const slideV = Vec2.clampLength(Vec2.scale(real, keep), Math.sqrt(vx * vx + vy * vy) * keep)
      vx = slideV.x - into.x * impact * BOUNCE
      vy = slideV.y - into.y * impact * BOUNCE
      nextSpin *= keep
    }
    data.pose.set({ x: moved.position.x, y: moved.position.y, angle: turned === undefined ? pose.angle : angle })
    // Settle to exact zero so a stopped, unattended car sleeps.
    const resting = input.throttle === 0 && vx * vx + vy * vy < 0.01
    data.motion.set(resting ? { vx: 0, vy: 0, spin: 0 } : { vx, vy, spin: nextSpin })
  }
})
