import assert from "node:assert/strict"
import { test } from "node:test"

import { Keyboard } from "@typeonce/ritmo-browser"
import { Vec2 } from "@typeonce/ritmo-math"

import { laneOf, lanePoint, laneSide, roadOf, walkSide } from "../sim/route.ts"
import { bindings, Game, Honk, Impact, KeyboardInput, makeRuntime, setup, update } from "../sim/index.ts"
import { parkedCar, pedestrian } from "../sim/spawning.ts"
import { BATTISTI, battistiTraffic, door, ON_BATTISTI, press, rolling, stage, type Timeline } from "../sim/testing.ts"
import { Audio, audio } from "./index.ts"
import type { Heard } from "./types.ts"

/** A runtime on `timeline` whose Audio service records every Heard, the audio schedule ticked after each update. */
const listen = (timeline: Timeline, ...staging: Parameters<typeof stage>) => {
  const frames: Array<Heard> = []
  const made = makeRuntime({
    seed: 1,
    services: Game.Runtime.services(
      Game.Runtime.service(KeyboardInput, Keyboard.scripted(bindings, timeline)),
      Game.Runtime.service(Audio, { hear: (heard: Heard) => frames.push(heard) })
    )
  })
  assert.ok(made.ok)
  const runtime = made.value
  assert.ok(runtime.tick(setup).ok)
  assert.ok(runtime.tick(stage(...staging)).ok)
  const run = (n: number) => {
    for (let i = 0; i < n; i++) assert.ok(runtime.tick(update, audio).ok)
  }
  return { runtime, run, frames }
}

test("hear: the player on foot, then at the wheel of a running car with the horn held, and a pedestrian nearby", () => {
  const lane = laneOf(BATTISTI.edge, BATTISTI.forward)
  const side = walkSide(roadOf(BATTISTI.edge))
  const verge = { ...lanePoint(lane, 8, side), angle: 0 }
  const walker = pedestrian({ skin: 0xc68e6a, hair: 0x2b1d14, shirt: 0xb8312b, pants: 0x1d2b4f }, verge, { ...BATTISTI, side }, { mood: "walk", until: 0 })
  const { run, frames } = listen([...press(1, "action"), { frame: 3, press: ["horn"] }], door(ON_BATTISTI), { cars: [parkedCar("panda", 0xb8312b, ON_BATTISTI)], peds: [walker] })
  run(4)
  assert.equal(frames.length, 4, "one Heard per tick")
  const [onFoot, , seated, horn] = frames
  assert.equal(onFoot!.listener.car, undefined)
  assert.ok(onFoot!.people.some((p) => p.player && Vec2.distance(p, door(ON_BATTISTI)) < 0.5), "the player on foot is a person")
  assert.ok(!onFoot!.vehicles.some((v) => Vec2.distance(v, ON_BATTISTI) < 0.5), "a parked, still car is silent")

  const mine = seated!.vehicles.filter((v) => v.mine)
  assert.equal(mine.length, 1)
  assert.deepEqual([mine[0]!.id, mine[0]!.model, mine[0]!.running], [seated!.listener.car, "panda", true])
  assert.ok(!seated!.people.some((p) => p.player), "the driver is no person on foot")
  assert.ok(seated!.people.some((p) => !p.player && !p.fleeing && !p.down && Vec2.distance(p, verge) < 2), "the pedestrian on the verge")
  assert.deepEqual([onFoot!.horn, seated!.horn, horn!.horn], [false, false, true])
})

test("hear: AI traffic runs even standing; a car nobody drives is heard only while it moves", () => {
  const lane = laneOf(BATTISTI.edge, BATTISTI.forward)
  const side = laneSide(BATTISTI, "panda")
  const coasting = { ...lanePoint(lane, 30, side), angle: ON_BATTISTI.angle }, parked = { ...lanePoint(lane, 60, side), angle: ON_BATTISTI.angle }
  const { run, frames } = listen([], door(ON_BATTISTI), {
    cars: [rolling("truck", coasting, 5, 0), parkedCar("panda", 0x3d6155, parked)],
    traffic: [battistiTraffic(0xd4a85e)]
  })
  run(1)
  const near = (p: { readonly x: number; readonly y: number }) => frames[0]!.vehicles.filter((v) => Vec2.distance(v, p) < 1)
  assert.deepEqual(near(ON_BATTISTI).map((v) => [v.model, v.running, v.mine]), [["panda", true, false]])
  assert.deepEqual(near(coasting).map((v) => [v.model, v.running, v.mine]), [["truck", false, false]])
  assert.deepEqual(near(parked), [])
})

test("hear: impacts then honks since the last frame, as happenings, each heard once", () => {
  const { runtime, run, frames } = listen([], door(ON_BATTISTI))
  run(1)
  runtime.send(Honk, { car: 7, model: "ape", x: 1, y: 2 })
  runtime.send(Impact, { hit: "car", x: 3, y: 4, speed: 5, mass: 0.5, car: 7, other: 8 })
  run(2)
  assert.deepEqual(frames.map((f) => f.happenings), [
    [],
    [{ kind: "impact", hit: "car", x: 3, y: 4, speed: 5, mass: 0.5, car: 7, other: 8 }, { kind: "honk", car: 7, model: "ape", x: 1, y: 2 }],
    []
  ])
})
