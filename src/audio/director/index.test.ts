import assert from "node:assert/strict"
import { test } from "node:test"

import type { VehicleModel } from "../../sim/vehicles.ts"
import { screenAxes } from "../../sim/view.ts"
import { AMBIENT_DB, CABIN, dbToGain, SPEED_OF_SOUND } from "../acoustics.ts"
import { bells } from "../places.ts"
import { stepRate } from "../synth/steps.ts"
import type { Continuous, Happening, Heard, HeardPerson, HeardVehicle, OneShot, Placement, Speaker } from "../types.ts"
import { makeDirector, type WallClock } from "./index.ts"
import { TOWERS, windDb } from "./levels.ts"

/**
 * Real map spots (found by probing the map): a treeless meadow on Monte dei Bianchi clear for 300 m to the south and
 * screen-right, a lane at Pian del Molino with a 10.7 m building 30 m east and open ground 30 m north-west, a wooded
 * ridge above Aiola (900 m) with no water within 400 m, Monzone station 68 m from the Torrente Lucido, a street
 * 50 m from Monzone Alto's tower, the woods above Isolano, in earshot of eleven bell towers, and the street of Monzone
 * where the game starts, 50 m from the Lucido behind the houses, with slopes to echo off; a bank 15 m from the Lucido
 * with nothing in the way, and the two flanks of Monte San Giorgio, 400 m apart.
 */
const MEADOW = { x: -329, y: 1078 }, STREET = { x: -916.6, y: 1706.8 }, BEHIND = { x: -886.6, y: 1706.8 }, OPEN = { x: -937.8, y: 1728 }
const RIDGE = { x: 1600, y: -494.5 }, STATION = { x: -494, y: 437 }, BELFRY = { x: -41.8, y: -306.6 }
const HILLSIDE = { x: -950, y: 71 }, SPAWN = { x: -412.6, y: 437.8 }, BANK = { x: -418.6, y: 395.8 }
const WEST_FLANK = { x: 785.7, y: -563.4 }, EAST_FLANK = { x: 1185.7, y: -563.4 }
const FRAME = 1 / 60
/** Screen-right on the ground, with the view in its home seat. */
const SCREEN_RIGHT = screenAxes(0).right

/** A small deterministic random source. */
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

/** A one-shot played at speaker time `t`, `delay` s ahead. */
interface Played { readonly sound: OneShot; readonly at: Placement; readonly delay: number; readonly t: number }

/** A director on a recording speaker whose clock (from `t`; 0 is no context yet) the test advances by `dt` per `hear`. */
const rig = (clock: () => WallClock = () => ({ hour: 10, minute: 10, second: 0 }), t = 1) => {
  let holding = new Map<string, { readonly sound: Continuous; readonly at: Placement }>()
  let held = holding
  const plays: Array<Played> = []
  const speaker: Speaker = {
    now: () => t,
    hold: (key, sound, at) => void holding.set(key, { sound, at }),
    play: (sound, at, delay) => void plays.push({ sound, at, delay, t }),
    flush: () => {
      held = holding
      holding = new Map()
    }
  }
  const director = makeDirector(speaker, { random: seeded(7), clock })
  return {
    plays,
    /** What the last frame held. */
    held: () => held,
    hear: (heard: Heard, frames = 1, dt = FRAME) => {
      for (let i = 0; i < frames; i++) {
        t += dt
        director.hear(heard)
      }
    },
    /** Plays of `kind` since it was last taken. */
    take: (kind: OneShot["kind"]): Array<Played> => {
      const taken = plays.filter((p) => p.sound.kind === kind)
      plays.splice(0, plays.length, ...plays.filter((p) => p.sound.kind !== kind))
      return taken
    }
  }
}

const car = (id: number, model: VehicleModel, at: { readonly x: number; readonly y: number }, more: Partial<HeardVehicle> = {}): HeardVehicle => ({
  id, model, x: at.x, y: at.y, angle: 0, vx: 0, vy: 0, throttle: 0, running: true, mine: false, ...more
})
const person = (id: number, at: { readonly x: number; readonly y: number }, more: Partial<HeardPerson> = {}): HeardPerson => ({
  id, x: at.x, y: at.y, vx: 0, vy: 0, player: false, fleeing: false, down: false, ...more
})
const world = (at: { readonly x: number; readonly y: number }, more: Partial<Heard> = {}, car?: number): Heard => ({
  listener: { x: at.x, y: at.y, vx: 0, vy: 0, car }, vehicles: [], people: [], happenings: [], horn: false, ...more
})
const away = (from: { readonly x: number; readonly y: number }, metres: number, dir: { readonly x: number; readonly y: number } = SCREEN_RIGHT) =>
  ({ x: from.x + metres * dir.x, y: from.y + metres * dir.y })
const SOUTH = { x: 0, y: -1 }

test("a running car 30 m away on screen-right is heard there; 2 km away it is not (proximity)", () => {
  const near = rig()
  near.hear(world(MEADOW, { vehicles: [car(1, "panda", away(MEADOW, 30))] }))
  const engine = near.held().get("engine:1")
  assert.ok(engine !== undefined && engine.at.gain > 0 && engine.at.pan > 0)
  const far = rig()
  far.hear(world(MEADOW, { vehicles: [car(1, "panda", away(MEADOW, 2000))] }))
  assert.equal(far.held().has("engine:1"), false)
})

test("a car at full load 300 m across the open meadow is heard; 400 m away behind Monte San Giorgio it is not", () => {
  const open = rig()
  open.hear(world(MEADOW, { vehicles: [car(1, "panda", away(MEADOW, 300, SOUTH), { throttle: 1 })] }))
  assert.equal(open.held().has("engine:1"), true)
  const behind = rig()
  behind.hear(world(WEST_FLANK, { vehicles: [car(1, "panda", EAST_FLANK, { throttle: 1 })] }))
  assert.equal(behind.held().has("engine:1"), false)
})

test("a building between the listener and a car 30 m away muffles it: lower gain and cutoff", () => {
  const director = rig()
  director.hear(world(STREET, { vehicles: [car(1, "panda", BEHIND), car(2, "panda", OPEN)] }))
  const behind = director.held().get("engine:1")!.at, open = director.held().get("engine:2")!.at
  // Being a metre farther (uphill) is worth under a decibel; the roof takes 15 dB and leaves the diffraction lowpass.
  assert.ok(behind.gain < open.gain * dbToGain(-10) && behind.cutoff <= 2800, `${behind.gain} < ${open.gain}, ${behind.cutoff} Hz`)
})

test("an approaching car is shifted up, a receding one down", () => {
  const cents = (speed: number) => {
    const director = rig()
    // 50 m screen-right, driving along screen-left (towards the listener) at `speed`.
    director.hear(world(MEADOW, { vehicles: [car(1, "panda", away(MEADOW, 50), { vx: -speed * SCREEN_RIGHT.x, vy: -speed * SCREEN_RIGHT.y })] }))
    return director.held().get("engine:1")!.at.cents
  }
  assert.ok(cents(20) > 0)
  assert.ok(cents(-20) < 0)
})

test("a pedestrian walking (or running) 5 m away steps at that pace's cadence; 40 m away nothing is heard", () => {
  const steps = (metres: number, speed = 2.2) => {
    const director = rig()
    const start = away(MEADOW, metres, SOUTH)
    for (let i = 0; i <= 180; i++) director.hear(world(MEADOW, { people: [person(9, { x: start.x + speed * i * FRAME, y: start.y }, { vx: speed })] }))
    return director.take("step").length
  }
  for (const speed of [2.2, 5]) assert.ok(Math.abs(steps(5, speed) - 3 * stepRate(speed)) <= 1, `${steps(5, speed)} steps in 3 s at ${speed} m/s`)
  assert.equal(steps(40), 0)
})

test("a wall impact at 10 m/s crashes; 300 m away it arrives after its travel time, 30 m away at once", () => {
  const crash = (metres: number) => {
    const director = rig()
    const at = away(MEADOW, metres, SOUTH)
    const hit: Happening = { kind: "impact", hit: "wall", x: at.x, y: at.y, speed: 10, mass: 1100, car: 1 }
    director.hear(world(MEADOW, { vehicles: [car(1, "panda", at)], happenings: [hit] }))
    return director.take("crash")
  }
  const [far] = crash(300)
  assert.ok(far !== undefined && Math.abs(far.delay - 300 / SPEED_OF_SOUND) < 0.02, `${far?.delay} s`)
  assert.equal(crash(30)[0]?.delay, 0)
})

test("a wall hit split over two steps crashes once, a 1.5× harder one at once again; soft contacts of a moving car grind for 0.2 s", () => {
  const director = rig()
  const at = away(MEADOW, 10, SOUTH)
  const step = (speeds: ReadonlyArray<number>, frames = 1, vx = 8) => director.hear(world(MEADOW, {
    vehicles: [car(1, "panda", at, { vx })],
    happenings: speeds.map((speed): Happening => ({ kind: "impact", hit: "wall", x: at.x, y: at.y, speed, mass: 1100, car: 1 }))
  }), frames)
  step([7.1])
  step([4.4])
  step([9])
  assert.equal(director.take("crash").length, 1, "the tail, and a hit not 1.5× harder")
  step([11])
  assert.equal(director.take("crash").length, 1, "a harder hit")
  step([], 7)
  step([3])
  assert.equal(director.take("crash").length, 1, "a new hit after 0.1 s")
  step([0.3])
  assert.equal(director.held().has("scrape:1"), true)
  step([], 13)
  assert.equal(director.held().has("scrape:1"), false, "0.2 s after the last contact")
  step([0.3], 1, 0)
  assert.equal(director.held().has("scrape:1"), false, "pressed against the wall, not moving along it")
  assert.equal(director.take("crash").length, 0)
})

test("a hard crash answers off the slopes, later and fainter; a soft one does not", () => {
  const crash = (speed: number) => {
    const director = rig()
    const at = away(SPAWN, 10, SOUTH)
    director.hear(world(SPAWN, { vehicles: [car(1, "panda", at)], happenings: [{ kind: "impact", hit: "wall", x: at.x, y: at.y, speed, mass: 1100, car: 1 }] }))
    return director.take("crash")
  }
  const [direct, ...echoes] = crash(10)
  assert.ok(echoes.length > 0 && echoes.every((e) => e.delay > direct!.delay + 0.1 && e.at.gain < direct!.at.gain / 2), `${echoes.length} echoes`)
  assert.equal(crash(4).length, 1)
})

test("before the audio context runs nothing is measured or played, but who sits where is still tracked", () => {
  const director = rig(undefined, 0)
  director.hear(world(MEADOW, { people: [person(1, MEADOW, { player: true })] }), 1, 0)
  director.hear(world(MEADOW, { vehicles: [car(5, "panda", MEADOW, { mine: true })] }, 5), 30, 0)
  assert.equal(director.plays.length, 0)
  director.hear(world(MEADOW, { vehicles: [car(5, "panda", MEADOW, { mine: true })] }, 5), 60)
  assert.equal(director.take("door").length, 0, "no doors replayed once it runs")
  assert.equal(director.held().has("engine:5"), true)
})

test("inside a closed car an outside engine is cut to the cabin's lowpass; the open Ape lets more in", () => {
  const outside = (model: VehicleModel) => {
    const director = rig()
    director.hear(world(MEADOW, { vehicles: [car(1, model, MEADOW, { mine: true }), car(2, "truck", away(MEADOW, 30))] }, 1))
    return director.held().get("engine:2")!.at
  }
  const panda = outside("panda"), ape = outside("ape")
  assert.ok(panda.cutoff <= 1400)
  assert.ok(ape.gain > panda.gain)
})

test("getting into a parked car: doors and the starter, the engine after it cranks; a running car: doors only; getting out: doors, engine off", () => {
  const director = rig()
  director.hear(world(MEADOW, { people: [person(1, MEADOW, { player: true })] }))
  director.hear(world(MEADOW, { vehicles: [car(5, "panda", MEADOW, { mine: true })] }, 5))
  assert.deepEqual(director.take("door").map((p) => [(p.sound as { open: boolean }).open, p.delay]), [[true, 0], [false, 0.7]])
  assert.equal(director.take("ignition").length, 1)
  assert.equal(director.held().has("engine:5"), false, "still cranking")
  director.hear(world(MEADOW, { vehicles: [car(5, "panda", MEADOW, { mine: true })] }, 5), 60)
  assert.equal(director.held().has("engine:5"), true)

  const carjack = rig()
  carjack.hear(world(MEADOW, { vehicles: [car(6, "panda", away(MEADOW, 2))], people: [person(1, MEADOW, { player: true })] }))
  carjack.hear(world(MEADOW, { vehicles: [car(6, "panda", MEADOW, { mine: true })] }, 6))
  assert.equal(carjack.take("door").length, 2)
  assert.equal(carjack.take("ignition").length, 0)
  assert.equal(carjack.held().has("engine:6"), true)
  carjack.hear(world(MEADOW, { people: [person(1, away(MEADOW, 1.5), { player: true })] }))
  assert.equal(carjack.take("door").length, 2)
  assert.equal(carjack.held().has("engine:6"), false)
})

test("in the Carabinieri car a horn press toggles the siren; in the Panda the horn sounds while the key is held", () => {
  const director = rig()
  const giulia = (horn: boolean) => director.hear(world(MEADOW, { vehicles: [car(7, "carabinieri", MEADOW, { mine: true })], horn }, 7))
  const sirens = [false, true, true, false, true].map((horn) => {
    giulia(horn)
    return director.held().has("siren:7")
  })
  assert.deepEqual(sirens, [false, true, true, true, false])
  assert.equal(director.held().has("horn:7"), false)

  const panda = rig()
  const horns = [false, true, true, false].map((horn) => {
    panda.hear(world(MEADOW, { vehicles: [car(8, "panda", MEADOW, { mine: true })], horn }, 8))
    return panda.held().get("horn:8")?.at
  })
  assert.deepEqual(horns.map((at) => at !== undefined), [false, true, true, false])
  // The horn sits in the grille, outside the cabin: the driver hears it through the whole body.
  assert.equal(horns[1]!.cutoff, CABIN.panda.cutoff)
})

test("bells: at 15:00 the nearby tower strikes three times 2.5 s apart, at 15:30 once, never twice in the same minute; only the loudest towers ring", () => {
  let now: WallClock = { hour: 15, minute: 0, second: 0 }
  const clock = () => now
  /** 15 s at `spot` (the clock then moves on within its minute): when each pitch's loudest strokes reach the ears (echoes are fainter). */
  const ring = (director: ReturnType<typeof rig>, spot: { readonly x: number; readonly y: number }) => {
    director.hear(world(spot), 15 * 60)
    now = { ...now, second: 30 }
    const rung = Map.groupBy(director.take("bell"), (p) => (p.sound.kind === "bell" ? p.sound.pitch : 0))
    return new Map([...rung].map(([pitch, plays]) => {
      const loudest = Math.max(...plays.map((p) => p.at.gain))
      return [pitch, plays.filter((p) => p.at.gain === loudest).map((p) => p.t + p.delay)] as const
    }))
  }
  const director = rig(clock)
  const tower = bells.reduce((a, b) => (Math.hypot(b.x - BELFRY.x, b.y - BELFRY.y) < Math.hypot(a.x - BELFRY.x, a.y - BELFRY.y) ? b : a))
  const [a, b, c, ...more] = ring(director, BELFRY).get(tower.pitch) ?? []
  assert.ok(more.length === 0 && Math.abs(b! - a! - 2.5) < 1e-6 && Math.abs(c! - b! - 2.5) < 1e-6, `${[a, b, c, ...more]}`)
  assert.equal(ring(director, BELFRY).size, 0, "the same minute again")
  now = { hour: 15, minute: 30, second: 0 }
  assert.equal(ring(director, BELFRY).get(tower.pitch)?.length, 1)
  // Eleven towers are in earshot of the woods above Isolano.
  const towers = ring(rig(clock), HILLSIDE).size
  assert.ok(towers > 0 && towers <= TOWERS, `${towers} towers rang`)
})

test("by the Torrente Lucido at Monzone station a water voice plays; on a dry ridge none", () => {
  const station = rig()
  station.hear(world(STATION))
  assert.ok([...station.held().keys()].some((key) => key.startsWith("water:")))
  const ridge = rig()
  ridge.hear(world(RIDGE))
  assert.ok(![...ridge.held().values()].some(({ sound }) => sound.kind === "water"))
})

test("the valley is never silent: in Monzone's sheltered street the wind blows at the rural background; the Lucido 15 m away in the clear plays near full, far louder and brighter than behind the houses, where it still plays (a river never masks itself)", () => {
  const street = rig()
  street.hear(world(SPAWN), 2)
  const wind = street.held().get("wind")?.sound
  assert.ok(wind?.kind === "wind" && windDb(wind.strength) >= AMBIENT_DB - 1e-9, `strength ${JSON.stringify(wind)}`)
  const bank = rig()
  bank.hear(world(BANK), 2)
  const near = bank.held().get("water:Torrente Lucido")!.at, behind = street.held().get("water:Torrente Lucido")!.at
  assert.ok(near.gain > dbToGain(-6) && near.gain > behind.gain * dbToGain(15), `${near.gain} vs ${behind.gain}`)
  assert.ok(near.cutoff > 2 * behind.cutoff, `${near.cutoff} vs ${behind.cutoff} Hz`)
})

test("twenty running cars around: only the eight loudest, nearest engines play, and near-equals do not swap", () => {
  const director = rig()
  // Every 10 m to the south; the ninth at `ninth` m.
  const cars = (ninth: number) => Array.from({ length: 20 }, (_, i) => car(i + 1, "panda", away(MEADOW, i === 8 ? ninth : 10 * (i + 1), SOUTH)))
  const engines = () => [...director.held().keys()].filter((key) => key.startsWith("engine:")).sort()
  const nearest = Array.from({ length: 8 }, (_, i) => `engine:${i + 1}`).sort()
  director.hear(world(MEADOW, { vehicles: cars(90) }))
  assert.deepEqual(engines(), nearest)
  director.hear(world(MEADOW, { vehicles: cars(75) }))
  assert.deepEqual(engines(), nearest, "the ninth a little nearer than the eighth: the eighth keeps its voice")
  director.hear(world(MEADOW, { vehicles: cars(40) }))
  assert.deepEqual(engines(), [...nearest.filter((key) => key !== "engine:8"), "engine:9"].sort())
})

test("a pedestrian who turns from walking to fleeing screams or shouts once, not again while still fleeing", () => {
  const director = rig()
  const at = away(MEADOW, 10, SOUTH)
  director.hear(world(MEADOW, { people: [person(4, at)] }), 10)
  director.hear(world(MEADOW, { people: [person(4, at, { fleeing: true })] }), 6 * 60)
  assert.equal(director.plays.filter((p) => p.sound.kind === "scream" || p.sound.kind === "shout").length, 1)
})
