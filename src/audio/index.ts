/**
 * The audio schedule: once per animation frame it projects what can be heard into plain `Heard`
 * data (the player's ears, vehicles someone drives or that move, people on foot, the Impact and
 * Honk events since the last frame, each impact with the bodies it struck, the horn key) and
 * hands it to the `Audio` service. No acoustics here: the director behind the service decides
 * what is loud enough and where it sits.
 * Read-only towards the world, like render (render/index.test.ts checks every described schedule).
 *
 * @module audio
 */
import { Descriptor } from "@typeonce/ritmo"

import {
  CarInput, Down, Driving, Game, Honk, Impact, Input, Motion, Pedestrian, Person, Player, Pose, Traffic, Vehicle
} from "../sim/index.ts"
import type { VehicleModel } from "../sim/vehicles.ts"
import type { Body, Happening, Heard, HeardPerson, HeardVehicle, Zone } from "./types.ts"

/** The host's ears: gets one `Heard` per frame while there is a player. */
export const Audio = Descriptor.Service<{ readonly hear: (heard: Heard) => void }>()("Lunigiana/Audio")

/** Below this speed (m/s), with no spin, a vehicle nobody drives is silent. */
const STILL = 0.01

/** Where (x, y) lies on a vehicle at `pose`: by its direction from the centre, within 45° of the heading the front, of its reverse the rear. */
const zoneOf = (pose: { readonly x: number; readonly y: number; readonly angle: number }, x: number, y: number): Zone => {
  const dx = x - pose.x, dy = y - pose.y, fx = Math.cos(pose.angle), fy = Math.sin(pose.angle)
  const along = dx * fx + dy * fy, across = Math.abs(dy * fx - dx * fy)
  return along > across ? "front" : -along > across ? "rear" : "side"
}

const Hear = Game.System("Lunigiana/Hear", {
  queries: {
    player: Game.Query({ selection: { pose: Game.Query.read(Pose), motion: Game.Query.read(Motion), driving: Game.Query.optional(Driving) }, with: [Player] }),
    vehicles: Game.Query({
      selection: {
        pose: Game.Query.read(Pose),
        motion: Game.Query.read(Motion),
        vehicle: Game.Query.read(Vehicle),
        input: Game.Query.read(CarInput),
        traffic: Game.Query.optional(Traffic)
      }
    }),
    people: Game.Query({
      selection: {
        pose: Game.Query.read(Pose),
        motion: Game.Query.read(Motion),
        pedestrian: Game.Query.optional(Pedestrian),
        down: Game.Query.optional(Down),
        player: Game.Query.optional(Player)
      },
      with: [Person],
      without: [Driving]
    })
  },
  resources: { input: Game.System.readResource(Input) },
  events: { impacts: Game.System.readEvent(Impact), honks: Game.System.readEvent(Honk) },
  services: { audio: Game.System.service(Audio) }
}, ({ queries, resources, events, services }) => {
  const found = queries.player.singleOptional()
  if (!found.ok || found.value === undefined) return
  const me = found.value.data
  const pose = me.pose.get(), motion = me.motion.get()
  const driving = me.driving.value()
  const car = driving === undefined ? undefined : Game.Entity.id(driving.vehicle)
  // Every vehicle's body, parked ones too: a struck parked car is not heard otherwise.
  const bodies = new Map<number, { readonly model: VehicleModel; readonly x: number; readonly y: number; readonly angle: number }>()
  const vehicles = queries.vehicles.each().flatMap(({ entity, data }): Array<HeardVehicle> => {
    const at = data.pose.get(), v = data.motion.get(), input = data.input.get(), { model } = data.vehicle.get()
    bodies.set(entity.id, { model, ...at })
    const mine = entity.id === car
    const running = mine || data.traffic.present
    if (!running && v.vx * v.vx + v.vy * v.vy <= STILL * STILL && v.spin === 0) return []
    return [{ id: entity.id, model, x: at.x, y: at.y, angle: at.angle, vx: v.vx, vy: v.vy, throttle: input.throttle, running, mine }]
  })
  /** Vehicle `id`'s model and the zone of it a hit at (x, y) landed on; undefined once it is gone. */
  const bodyAt = (id: number, x: number, y: number): Body | undefined => {
    const found = bodies.get(id)
    return found === undefined ? undefined : { model: found.model, zone: zoneOf(found, x, y) }
  }
  const people = queries.people.each().map(({ entity, data }): HeardPerson => {
    const at = data.pose.get(), v = data.motion.get()
    return {
      id: entity.id, x: at.x, y: at.y, vx: v.vx, vy: v.vy,
      player: data.player.present, fleeing: data.pedestrian.value()?.mood === "flee", down: data.down.present
    }
  })
  const happenings: Array<Happening> = [
    // A vehicle despawned since its hit is no longer heard.
    ...events.impacts.all().flatMap((hit): Array<Happening> => {
      const body = bodyAt(hit.car, hit.x, hit.y), otherBody = hit.hit === "car" && hit.other !== undefined ? bodyAt(hit.other, hit.x, hit.y) : undefined
      if (body === undefined || (hit.hit === "car" && otherBody === undefined)) return []
      return [{ kind: "impact", ...hit, body, ...(otherBody === undefined ? {} : { otherBody }) }]
    }),
    ...events.honks.all().map((honk) => ({ kind: "honk" as const, ...honk }))
  ]
  services.audio.hear({
    listener: { x: pose.x, y: pose.y, vx: motion.vx, vy: motion.vy, car },
    vehicles,
    people,
    happenings,
    horn: resources.input.get().horn.held
  })
})

/** The audio schedule, ticked once per animation frame after `render` (its first tick right after `setup`, so no event is missed). */
export const audio = Game.Schedule(Hear)
