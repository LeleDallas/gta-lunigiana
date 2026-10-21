/**
 * Every vehicle sound: engines (the listener's own from the driver's seat), tyres, horns and the
 * Carabinieri siren, the truck's reversing beeper, crashes, scrapes along walls and people hit,
 * AI honks, and the doors and starter of the listener getting in and out. A crash knows both bodies
 * (the listener's own car always as `body`), the wall's material and the ground under it; a scrape,
 * the wall's material. Sounds of the listener's own car are heard from inside it: its crash, scrape
 * and doors through no cabin, its horn and siren (out by the grille, up on the roof) through all of it.
 *
 * @module audio/director/vehicles
 */
import { forwardSpeed } from "../../sim/body.ts"
import type { VehicleModel } from "../../sim/vehicles.ts"
import { hash01 } from "../../tools/geometry.ts"
import { mixGain } from "../acoustics.ts"
import { surfaceAt, wallAt } from "../places.ts"
import { crashQuiet } from "../synth/crash/index.ts"
import { CRANK } from "../synth/impacts.ts"
import type { HeardVehicle, Material, OneShot } from "../types.ts"
import { type Frame, groundAt } from "./frame.ts"
import type { Hearing, Source } from "./hearing.ts"
import { ENGINE, HEIGHT, LEVELS, OWN_ENGINE_DB } from "./levels.ts"

/** Tyres roll audibly above this speed, m/s; the beeper sounds below this forward speed. */
const ROLLING = 1, REVERSING = -0.3
/** Impacts from this speed crash (m/s); softer wall contacts of a car still faster than `SCRAPING` grind for `SCRAPE_HOLD` s. */
const CRASH_FROM = 1.5, SCRAPING = 2, SCRAPE_HOLD = 0.2
/** One hit arrives over a few steps: within `MERGE` s of a car's crash only a `HARDER`× harder one plays. */
const MERGE = 0.1, HARDER = 1.5
/** A person hit groans this long after the thud, s; a door closes this long after it opened, s. */
const GROAN_AFTER = 0.25, DOOR_CLOSES = 0.7

/** The own engine, from the driver's seat: centred, open, no Doppler; the voice makes the cabin tone. */
const OWN_ENGINE: Hearing = {
  placement: { gain: mixGain(OWN_ENGINE_DB, 0), pan: 0, cutoff: 20000, cents: 0, wet: 0 },
  level: OWN_ENGINE_DB,
  audible: true,
  r: 0,
  delay: 0
}

const sourceOf = (v: HeardVehicle): Source => ({ x: v.x, y: v.y, z: groundAt(v.x, v.y) + HEIGHT.vehicle, vx: v.vx, vy: v.vy })

/** The vehicle part of the director, with what it remembers between frames. */
export const makeVehicles = () => {
  // The listener's vehicle last frame, and the vehicles that were running then.
  let car: number | undefined, model: VehicleModel | undefined
  let running: ReadonlySet<number> = new Set()
  let horn = false
  /** Vehicle → when its engine catches, after the starter. */
  const cranking = new Map<number, number>()
  const sirens = new Set<number>()
  /** Vehicle → its last crash; vehicle → until when it scrapes, and along what. */
  const crashes = new Map<number, { readonly at: number; readonly speed: number }>()
  const scrapes = new Map<number, { readonly until: number; readonly material: Material }>()

  return {
    hear: (frame: Frame): void => {
      const { heard, now } = frame, mine = heard.listener.car
      const byId = new Map(heard.vehicles.map((v) => [v.id, v]))
      // Own sounds come from the car the ears sit in: no occlusion key.
      const keyOf = (id: number) => (id === mine ? undefined : `car:${id}`)

      // Getting in: the door, and the starter if the engine was off; getting out: the door where the listener now stands.
      if (car === undefined && mine !== undefined) {
        const v = byId.get(mine)
        if (v !== undefined) {
          const at = sourceOf(v), door = frame.path(undefined, at, LEVELS.door, { cabin: false })
          frame.play({ kind: "door", model: v.model, open: true }, door)
          frame.play({ kind: "door", model: v.model, open: false }, door, DOOR_CLOSES)
          if (!running.has(mine)) {
            frame.play({ kind: "ignition", model: v.model }, frame.path(undefined, at, LEVELS.ignition, { cabin: false }))
            cranking.set(mine, now + CRANK[v.model].seconds)
          }
        }
      } else if (car !== undefined && mine === undefined && model !== undefined) {
        const { x, y } = heard.listener, door = frame.path(undefined, { x, y, z: groundAt(x, y) + HEIGHT.person }, LEVELS.door)
        frame.play({ kind: "door", model, open: true }, door)
        frame.play({ kind: "door", model, open: false }, door, DOOR_CLOSES)
      }

      for (const [id, until] of cranking) if (until <= now) cranking.delete(id)
      for (const [id, { until }] of scrapes) if (until <= now) scrapes.delete(id)
      for (const [id, last] of crashes) if (now - last.at >= MERGE) crashes.delete(id)
      // The hardest hits first, so the softer tail of the same hit merges into them.
      const hits = heard.happenings.flatMap((h) => (h.kind === "impact" && h.hit !== "person" ? [h] : [])).sort((a, b) => b.speed - a.speed)
      for (const hit of hits) {
        const v = byId.get(hit.car)
        if (hit.speed < CRASH_FROM) {
          if (hit.hit === "wall" && v !== undefined && Math.hypot(v.vx, v.vy) > SCRAPING) scrapes.set(hit.car, { until: now + SCRAPE_HOLD, material: wallAt(hit.x, hit.y) })
          continue
        }
        const last = Math.max(crashes.get(hit.car)?.speed ?? 0, hit.other === undefined ? 0 : (crashes.get(hit.other)?.speed ?? 0))
        if (hit.speed < HARDER * last) continue
        for (const id of [hit.car, hit.other]) if (id !== undefined) crashes.set(id, { at: now, speed: hit.speed })
        // The contact sounds the same from either car: the listener's is always `body`. (On foot `mine` and a wall hit's `other` are both undefined.)
        const theirs = mine !== undefined && hit.other === mine && hit.otherBody !== undefined
        const own = theirs || hit.car === mine
        const [body, other] = theirs ? [hit.otherBody, hit.body] : [hit.body, hit.otherBody]
        const sound: Extract<OneShot, { readonly kind: "crash" }> = {
          kind: "crash", speed: hit.speed, mass: hit.mass, body,
          against: other === undefined ? { kind: "wall", material: wallAt(hit.x, hit.y) } : { kind: "car", body: other },
          surface: surfaceAt(hit.x, hit.y), inside: own
        }
        const at = frame.path(own ? undefined : `car:${hit.car}`, { x: hit.x, y: hit.y, z: groundAt(hit.x, hit.y) + HEIGHT.vehicle }, LEVELS.crash, { cabin: !own, quiet: crashQuiet(sound) })
        frame.play(sound, at)
      }
      for (const h of heard.happenings) {
        if (h.kind === "honk") {
          frame.play({ kind: "honk", model: h.model }, frame.path(`car:${h.car}`, { x: h.x, y: h.y, z: groundAt(h.x, h.y) + HEIGHT.vehicle }, LEVELS.honk))
        } else if (h.hit === "person") {
          const who = h.other ?? h.car, key = `person:${who}`, at = { x: h.x, y: h.y, z: groundAt(h.x, h.y) + HEIGHT.person }
          frame.play({ kind: "thud", speed: h.speed }, frame.path(key, at, LEVELS.thud, { cabin: h.car !== mine }))
          frame.play({ kind: "groan", voice: hash01(who) }, frame.path(key, at, LEVELS.groan), GROAN_AFTER)
        }
      }

      // The Carabinieri's horn key toggles the siren; it falls silent once nobody drives the car.
      const pressed = heard.horn && !horn
      for (const v of heard.vehicles) {
        if (!v.mine || v.model !== "carabinieri" || !pressed) continue
        if (sirens.has(v.id)) sirens.delete(v.id)
        else sirens.add(v.id)
      }
      for (const id of sirens) if (byId.get(id)?.running !== true) sirens.delete(id)

      for (const v of heard.vehicles) {
        const at = sourceOf(v), key = keyOf(v.id), forward = forwardSpeed(v, v.angle), speed = Math.hypot(v.vx, v.vy)
        const catches = cranking.get(v.id)
        if (v.running && (catches === undefined || catches <= now)) {
          const engine = { kind: "engine", model: v.model, speed: forward, throttle: v.throttle, inside: v.id === mine } as const
          frame.hold(`engine:${v.id}`, engine, v.id === mine ? OWN_ENGINE : frame.path(key, at, ENGINE[v.model], { doppler: true }))
        }
        if (speed > ROLLING) {
          // Sideways: the velocity along the car's left axis.
          const slip = Math.abs(-v.vx * Math.sin(v.angle) + v.vy * Math.cos(v.angle))
          const tyres = { kind: "tyres", speed, slip, surface: surfaceAt(v.x, v.y), heavy: v.model === "truck" } as const
          frame.hold(`tyres:${v.id}`, tyres, frame.path(key, at, LEVELS.tyres, { doppler: true }))
        }
        if (v.mine && heard.horn && v.model !== "carabinieri") {
          frame.hold(`horn:${v.id}`, { kind: "horn", model: v.model }, frame.path(key, at, LEVELS.horn, { doppler: true }))
        }
        if (sirens.has(v.id)) frame.hold(`siren:${v.id}`, { kind: "siren" }, frame.path(key, at, LEVELS.siren, { doppler: true }))
        if (v.running && v.model === "truck" && forward < REVERSING) frame.hold(`beeper:${v.id}`, { kind: "beeper" }, frame.path(key, at, LEVELS.beeper, { doppler: true }))
        const scrape = scrapes.get(v.id)
        if (scrape !== undefined) frame.hold(`scrape:${v.id}`, { kind: "scrape", speed, material: scrape.material }, frame.path(key, at, LEVELS.scrape, { doppler: true, cabin: v.id !== mine }))
      }

      car = mine
      model = mine === undefined ? undefined : byId.get(mine)?.model
      running = new Set(heard.vehicles.flatMap((v) => (v.running ? [v.id] : [])))
      horn = heard.horn
    }
  }
}
