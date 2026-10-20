import assert from "node:assert/strict"
import { test } from "node:test"

import { HostClock } from "@typeonce/ritmo"
import { Keyboard } from "@typeonce/ritmo-browser"
import { Determinism } from "@typeonce/ritmo-devtools"
import { Ops, Vec2 } from "@typeonce/ritmo-math"

import { ringBox } from "../tools/geometry.ts"
import { carClear } from "./body.ts"
import { graph, MAP } from "./map/index.ts"
import { pointInRing } from "./collide.ts"
import { distanceToEdge, laneOf, lanePoint, laneSide, roadOf, walkIndex } from "./route.ts"
import { bindings, Game, KeyboardInput, makeRuntime, type PoseValue, setup, update } from "./index.ts"
import { parkedCar, pedestrian } from "./spawning.ts"
import { PEDESTRIANS, PEOPLED, TRAFFIC } from "./systems/populate.ts"
import { PARKED } from "./systems/spawn.ts"
import { BATTISTI, battistiTraffic, door, ON_BATTISTI, press, stage, start, straightOn, teleport, type Timeline, walkClear } from "./testing.ts"
import { screenAxes, VIEW_REACH } from "./view.ts"
import { VEHICLES } from "./vehicles.ts"

test("setup: the player at the map spawn, 200 parked cars on random spots, Carabinieri in front of the station", () => {
  const { run, view, world } = start()
  run(1)
  assert.equal(view()?.mode, "foot")
  assert.deepEqual(view()?.pose, MAP.spawns.player)
  const { vehicles } = world()
  assert.equal(vehicles.length, Math.min(PARKED, MAP.spawns.parked.length))
  assert.ok(vehicles.length >= 40, `${vehicles.length} parked cars`)
  assert.ok(vehicles.every((v) => !v.traffic && v.input.handbrake))
  assert.ok(vehicles.every((v) => MAP.spawns.parked.some((s) => s.x === v.x && s.y === v.y && s.angle === v.angle)), "every car on a parked spot")
  const police = MAP.pois.find((p) => p.kind === "amenity=police")!
  const nearest = [...MAP.spawns.parked].sort((a, b) => Vec2.distance(a, police) - Vec2.distance(b, police)).slice(0, 2)
  const carabinieri = vehicles.filter((v) => v.model === "carabinieri")
  assert.equal(carabinieri.length, 2)
  assert.ok(carabinieri.every((v) => v.color === 0x1d2b4f && nearest.some((s) => s.x === v.x && s.y === v.y)))
  assert.ok(carabinieri.every((v) => Vec2.distance(v, police) < 45), "Carabinieri in front of their station")
  assert.ok(vehicles.filter((v) => v.model === "truck").length <= 2)
})

test("on foot: the up key walks along screen-up and stops at a building wall", () => {
  // 6 m north-west of a house wall that faces the camera (1.3° off square on), 5.65 m to contact.
  const from = { x: -59.4926, y: 160.9426, angle: 0 }
  const { run, view } = start([{ frame: 0, press: ["up"] }], [from])
  const { up } = screenAxes(0)
  const along = (p: PoseValue) => (p.x - from.x) * up.x + (p.y - from.y) * up.y
  const across = (p: PoseValue) => (p.x - from.x) * up.y - (p.y - from.y) * up.x
  const path: Array<PoseValue> = []
  run(240, () => path.push(view()!.pose))
  assert.ok(along(path[20]!) > 0.3 && Math.abs(across(path[20]!)) < 1e-9, JSON.stringify(path[20]))
  assert.ok(path.every(walkClear), "never inside a wall")
  assert.ok(path.every((p) => along(p) < 5.66), "never past the wall")
  const last = path.at(-1)!
  assert.ok(along(last) > 5.5 && Math.abs(across(last)) < 0.3, `stopped at the wall: ${along(last)}, ${across(last)}`)
  assert.ok(Vec2.distance(path.at(-30)!, last) < 0.05, "standing (all but) still against it")
})

test("driving: entering a parked car, the up key accelerates toward maxSpeed and the left key turns CCW", () => {
  const timeline: Timeline = [...press(0, "action"), { frame: 2, press: ["up"] }, { frame: 92, press: ["left"] }]
  const { run, view, world } = start(timeline, [door(ON_BATTISTI), { cars: [parkedCar("panda", 0xb8312b, ON_BATTISTI)] }])
  run(1)
  assert.equal(view()?.mode, "driving")
  assert.equal(world().score.stolen, 1)
  const speeds: Array<number> = []
  run(91, () => speeds.push(view()!.vehicle!.speed))
  assert.ok(speeds.every((v, i) => i === 0 || v >= speeds[i - 1]!), "speeds up every step")
  const top = speeds.at(-1)!
  assert.ok(top > 8 && top < VEHICLES.panda.maxSpeed, `speed after 1.5 s: ${top}`)
  const heading = view()!.pose.angle
  run(18)
  assert.ok(view()!.pose.angle > heading + 0.3, `left turns counter-clockwise: ${heading} -> ${view()!.pose.angle}`)
})

test("driving into a building: the car stops at the wall without tunnelling and loses its speed", () => {
  // Square on to an 11 m house wall on Via Cesare Battisti, 18.15 m to first contact.
  const car = { x: -433.525, y: 433.24, angle: 1.386 }
  const { run, view } = start([...press(0, "action"), { frame: 2, press: ["up"] }], [door(car), { cars: [parkedCar("panda", 0xf2efe6, car)] }])
  const progress = (p: PoseValue) => (p.x - car.x) * Ops.cos(car.angle) + (p.y - car.y) * Ops.sin(car.angle)
  const frames: Array<{ pose: PoseValue; speed: number }> = []
  run(240, () => frames.push({ pose: view()!.pose, speed: view()!.vehicle!.speed }))
  assert.ok(frames.every(({ pose }) => carClear("panda", pose, 0.02)), "never inside a wall")
  assert.ok(frames.every(({ pose }) => progress(pose) < 18.17), `never past the wall: ${Math.max(...frames.map(({ pose }) => progress(pose)))}`)
  const fastest = Math.max(...frames.map((f) => f.speed))
  const hit = frames.findIndex((f) => f.speed === fastest)
  assert.ok(fastest > 12, `fastest ${fastest}`)
  assert.ok(Math.min(...frames.slice(hit, hit + 10).map((f) => f.speed)) < fastest * 0.5, "the hit costs speed")
})

test("exit: the player gets out at the driver's door, clear of walls, and the car keeps its handbrake on", () => {
  const { run, view, world } = start([...press(0, "action"), ...press(30, "action")], [door(ON_BATTISTI, -1), { cars: [parkedCar("panda", 0x3d6155, ON_BATTISTI)] }])
  run(30)
  assert.equal(view()?.mode, "driving")
  run(1)
  const me = view()!
  const [car] = world().vehicles
  assert.equal(me.mode, "foot")
  assert.ok(Math.abs(Vec2.distance(me.pose, car!) - (VEHICLES.panda.width / 2 + 0.6)) < 1e-6, "beside the car")
  assert.ok((me.pose.x - car!.x) * -Ops.sin(car!.angle) + (me.pose.y - car!.y) * Ops.cos(car!.angle) > 0, "on its left")
  assert.ok(walkClear(me.pose))
  assert.equal(car!.input.handbrake, true)
})

test("view: Q turns the view a quarter left, E a quarter right, and the up key walks along the turned screen-up", () => {
  for (const [keys, turns] of [[["turnLeft"], 1], [["turnLeft", "turnLeft"], 2], [["turnRight"], -1]] as const) {
    const { run, view } = start([...keys.flatMap((key, i) => press(2 * i, key)), { frame: 4, press: ["up"] }], [ON_BATTISTI])
    run(4)
    assert.equal(view()!.turns, turns)
    const from = view()!.pose
    run(20)
    const to = view()!.pose, { up } = screenAxes(turns)
    const along = (to.x - from.x) * up.x + (to.y - from.y) * up.y, across = (to.x - from.x) * up.y - (to.y - from.y) * up.x
    assert.ok(along > 0.3 && Math.abs(across) < 1e-9, `turns ${turns}: ${along} along, ${across} across`)
  }
})

// Regression: the camera led by the pose change, so the hop in or out of a car jolted it.
test("view: getting in and out hops the pose to the seat and the door, at zero velocity", () => {
  const { run, view } = start([...press(0, "action"), ...press(30, "action")], [door(ON_BATTISTI), { cars: [parkedCar("panda", 0x3d6155, ON_BATTISTI)] }])
  for (const [frames, mode] of [[1, "driving"], [30, "foot"]] as const) {
    run(frames)
    const { prev, pose, velocity, mode: now } = view()!
    assert.equal(now, mode)
    assert.ok(Vec2.distance(prev, pose) > 1, "the hop")
    assert.equal(velocity.x ** 2 + velocity.y ** 2, 0)
  }
})

test("carjacking: the driver is thrown out and flees, the car stops being traffic, one theft scored", () => {
  const { run, view, world } = start(press(0, "action"), [door(ON_BATTISTI, -1), { traffic: [battistiTraffic(0xd4a85e)] }])
  run(1)
  assert.equal(view()?.mode, "driving")
  const after = world()
  assert.deepEqual(after.vehicles.map((v) => [v.traffic, v.stolen]), [[false, true]])
  assert.equal(after.score.stolen, 1)
  assert.equal(after.peds.length, 1)
  const driver = after.peds[0]!
  assert.equal(driver.mood, "flee")
  assert.ok(Vec2.distance(driver, door(ON_BATTISTI)) < 0.5, "out of the driver's door")
  run(90)
  const fled = world().peds.find((p) => p.id === driver.id)!
  assert.ok(Vec2.distance(fled, ON_BATTISTI) > 4, `ran off: ${Vec2.distance(fled, ON_BATTISTI)}`)
})

test("traffic: a car follows the roads for 30 s, never inside walls", () => {
  const { run, world } = start([], [MAP.spawns.player, { traffic: [battistiTraffic(0x74746f)] }])
  const id = world().vehicles[0]!.id
  let travelled = 0
  let last: PoseValue = ON_BATTISTI
  run(1800, () => {
    const car = world().vehicles.find((v) => v.id === id)!
    // Within a metre of a traffic road's carriageway (corners get cut): measured from every edge, so a car
    // turning out of a lane into a wider road is judged by the wider road.
    let off = Infinity
    for (const e of graph.trafficEdges) off = Math.min(off, distanceToEdge(e, car.x, car.y) - roadOf(e).w / 2)
    assert.ok(off < 1, `${off} m beyond the carriageway at (${car.x}, ${car.y})`)
    assert.ok(carClear("panda", car, 0.02), "never inside a wall")
    travelled += Vec2.distance(car, last)
    last = car
  })
  assert.ok(travelled > 60, `travelled ${travelled} m`)
})

// Regression: waiting 3 s for a walker crossing in front counted as stuck, so cars backed up and turned round on narrow roads, onto the verge.
test("traffic: a car waits for a person standing in its lane, without backing up or turning round, then drives on", () => {
  const lane = laneOf(BATTISTI.edge, BATTISTI.forward)
  const inLane = { ...lanePoint(lane, 12, laneSide(BATTISTI, "panda")), angle: 0 }
  const { runtime, run, view, world } = start([], [inLane, { traffic: [battistiTraffic(0x74746f)] }])
  const id = world().vehicles[0]!.id
  const car = () => world().vehicles.find((v) => v.id === id)!
  const along = () => (car().x - lane.x) * lane.dx + (car().y - lane.y) * lane.dy
  let furthest = along()
  run(480, () => {
    assert.ok(along() > furthest - 0.05, `backed up from ${furthest} to ${along()}`)
    assert.equal(car().route?.forward, BATTISTI.forward, "kept its direction")
    furthest = Math.max(furthest, along())
  })
  assert.equal(view()?.mode, "foot", "stopped short of the person")
  assert.ok(furthest > 3 && furthest < 12 - 2, `waited in front of them: ${furthest}`)
  assert.ok(runtime.tick(Game.Schedule(teleport(MAP.spawns.player))).ok)
  run(180)
  assert.ok(along() > furthest + 5, `drove on: ${along()}`)
})

// Regression: waiting for a person never counted as stuck, so one who stood still in the lane (or beside the cab, or on
// the verge inside the braking cone) held the car for good, and the cars queued behind it wedged turning round.
test("traffic: a person who never moves holds a car ~12 s in its lane, and beside its cab no longer than a parked car would", () => {
  const lane = laneOf(BATTISTI.edge, BATTISTI.forward)
  const side = laneSide(BATTISTI, "panda")
  const along = (p: PoseValue) => (p.x - lane.x) * lane.dx + (p.y - lane.y) * lane.dy
  for (const [at, from, to] of [[12, 8, 20], [0.5, 2.5, 6]] as const) {
    // In the lane 12 m ahead; or 1.3 m right of the standing car's axis, beside its cab (on the carriageway, clear of the body).
    const me = { ...lanePoint(lane, at, at === 12 ? side : side + 1.3), angle: 0 }
    assert.ok(walkClear(me) && distanceToEdge(BATTISTI.edge, me.x, me.y) < roadOf(BATTISTI.edge).w / 2)
    const { run, world } = start([], [me, { traffic: [battistiTraffic(0x74746f)] }])
    const car = () => world().vehicles.find((v) => v.traffic)!
    let furthest = along(car()), gaveUp = -1
    run(to * 60, (frame) => {
      furthest = Math.max(furthest, along(car()))
      if (gaveUp < 0 && (along(car()) < furthest - 0.5 || car().route?.forward !== BATTISTI.forward)) gaveUp = frame / 60
    })
    assert.ok(gaveUp >= from && gaveUp < to, `person at ${at} m: backed up or turned round after ${gaveUp} s`)
  }
})

test("knockdown: a fast car knocks a pedestrian down, scores for the player, and the pedestrian gets up and runs", () => {
  // The pedestrian walks toward the car down its lane line, 25 m ahead on the next edge.
  const next = straightOn(BATTISTI)
  const side = laneSide(next, "panda")
  const at = { ...lanePoint(laneOf(next.edge, next.forward), 5, side), angle: ON_BATTISTI.angle + Math.PI }
  const walker = pedestrian({ skin: 0xc68e6a, hair: 0x2b1d14, shirt: 0xb8312b, pants: 0x1d2b4f }, at, { edge: next.edge, forward: !next.forward, side: -side }, { mood: "walk", until: 0 })
  const timeline: Timeline = [...press(0, "action"), { frame: 2, press: ["up"] }, { frame: 200, release: ["up"] }]
  const { run, world } = start(timeline, [door(ON_BATTISTI), { cars: [parkedCar("panda", 0xb8312b, ON_BATTISTI)], peds: [walker] }])
  let knockedAt = -1
  run(200, (frame) => {
    if (knockedAt < 0 && world().peds[0]!.down) knockedAt = frame
  })
  assert.ok(knockedAt > 0, "knocked down")
  assert.equal(world().score.knocked, 1)
  run(150)
  const [ped] = world().peds
  assert.equal(ped!.down, false, "back up after 2.5 s")
  assert.equal(ped!.mood, "flee")
})

test("populate: traffic and pedestrians fill in out of view around a moving player within the limits, and far ones go", () => {
  const { runtime, run, view, world } = start()
  const counts = () => {
    const { vehicles, peds } = world()
    const traffic = vehicles.filter((v) => v.traffic).length
    assert.ok(traffic <= TRAFFIC.max, `${traffic} traffic cars`)
    assert.ok(peds.length <= PEDESTRIANS.max, `${peds.length} pedestrians`)
    return { traffic, peds: peds.length }
  }
  // Regression: pedestrians spawned 53 m away, well inside the driving view.
  const seen = new Set(world().vehicles.map((v) => v.id))
  const outOfView = () => {
    const me = view()!.pose
    const { vehicles, peds } = world()
    for (const body of [...vehicles, ...peds]) {
      if (seen.has(body.id)) continue
      seen.add(body.id)
      assert.ok(Vec2.distance(body, me) >= VIEW_REACH, `spawned ${Vec2.distance(body, me).toFixed(1)} m from the player`)
    }
  }
  run(600, (frame) => {
    outOfView()
    if (frame % 30 === 29) counts()
  })
  assert.ok(counts().traffic >= 5, "traffic arrived")
  assert.ok(counts().peds >= 10, "pedestrians arrived")
  // The player crosses the village at 20 m/s: what fell behind goes, the caps hold all the way.
  const from = MAP.spawns.player
  for (let leg = 1; leg <= 20; leg++) {
    assert.ok(runtime.tick(Game.Schedule(teleport({ x: from.x + leg * 20, y: from.y - leg * 12, angle: 0 }))).ok)
    run(60, (frame) => {
      outOfView()
      if (frame % 30 === 29) counts()
    })
  }
  const away = { x: from.x + 400, y: from.y - 240, angle: 0 }
  const after = world()
  assert.ok(after.vehicles.filter((v) => v.traffic).every((v) => Vec2.distance(v, away) <= TRAFFIC.despawn))
  assert.ok(after.peds.every((p) => Vec2.distance(p, away) <= PEDESTRIANS.despawn))
  assert.ok(after.vehicles.some((v) => !v.traffic && Vec2.distance(v, away) > TRAFFIC.despawn), "parked cars stay")
})

// Regression: verges that run into houses spawned pedestrians inside them (stuck under the roof for good).
test("populate: pedestrians spawn in the villages, never inside a house, and none in the woods", () => {
  const indoors = (p: { readonly x: number; readonly y: number }) =>
    MAP.buildings.some((b) => pointInRing(p.x, p.y, b.outer) && !(b.holes ?? []).some((h) => pointInRing(p.x, p.y, h)))
  // A walk node with walk edges in the spawn band but no building within PEOPLED of any of them.
  const lonely = (n: { readonly x: number; readonly y: number }) => MAP.buildings.every((b) => {
    const [x0, y0, x1, y1] = ringBox(b.outer)
    return Ops.hypot(Math.max(x0 - n.x, 0, n.x - x1), Math.max(y0 - n.y, 0, n.y - y1)) > PEOPLED + PEDESTRIANS.spawn[1]
  })
  const woods = graph.nodes.find((n) => walkIndex.around(n.x, n.y, PEDESTRIANS.spawn).length > 0 && lonely(n))!
  for (const [at, some] of [[{ x: -1751.2, y: 3360.4 }, true], [woods, false]] as const) { // Gragnola's place node, then the woods
    const { runtime, run, world } = start()
    assert.ok(runtime.tick(Game.Schedule(teleport({ ...at, angle: 0 }))).ok)
    const seen = new Set<number>()
    run(600, () => {
      for (const p of world().peds) if (!seen.has(p.id)) {
        seen.add(p.id)
        assert.ok(!indoors(p), `spawned inside a house at ${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      }
    })
    assert.ok(some ? seen.size >= 10 : seen.size === 0, `${seen.size} pedestrians around ${at.x},${at.y}`)
  }
})

/** Walk to a car, drive it hard around Via Cesare Battisti, turn the view, get out: every system has work to do. */
const joyride: Timeline = [
  { frame: 0, press: ["left"] }, { frame: 10, release: ["left"] },
  ...press(12, "action"),
  { frame: 14, press: ["up"] }, { frame: 100, press: ["left"] }, { frame: 130, release: ["left"], press: ["handbrake", "right"] },
  { frame: 170, release: ["handbrake", "right"] }, ...press(200, "turnLeft"), { frame: 240, release: ["up"], press: ["down"] }, { frame: 300, release: ["down"] },
  ...press(330, "action"), { frame: 340, press: ["up", "sprint"] }, { frame: 400, release: ["up", "sprint"] }
]
const joyrideCast = [door(ON_BATTISTI), { cars: [parkedCar("panda", 0xb8312b, ON_BATTISTI)] }] as const

test("determinism: the same scripted joyride replays bit for bit", () => {
  const result = Determinism.check(({ hostClock }) => {
    const made = makeRuntime({ seed: 7, services: Game.Runtime.services(Game.Runtime.service(KeyboardInput, Keyboard.scripted(bindings, joyride))), debug: { hostClock } })
    if (!made.ok) throw new Error(JSON.stringify(made.error))
    const ready = made.value.tick(setup, stage(...joyrideCast))
    if (!ready.ok) throw new Error(JSON.stringify(ready.error))
    return { runtime: made.value, schedules: { update } }
  }, { schedule: "update", frames: 600, hostClock: HostClock.test() })
  assert.deepEqual(result, { ok: true, frames: 600 })
})

test("saves: a snapshot taken mid-joyride restores through JSON and plays on identically", () => {
  const a = start(joyride, joyrideCast)
  const modes: Array<string> = []
  a.run(420, () => {
    const mode = a.view()!.mode
    if (modes.at(-1) !== mode) modes.push(mode)
  })
  assert.deepEqual(modes, ["foot", "driving", "foot"], "the joyride gets in, drives and gets out")
  assert.equal(a.view()!.turns, 1, "and turns the view")
  const b = start()
  assert.ok(b.runtime.restore(JSON.parse(JSON.stringify(a.runtime.snapshot()))).ok)
  assert.deepEqual(b.view(), a.view())
  assert.deepEqual(b.world(), a.world())
  a.run(120)
  b.run(120)
  assert.deepEqual(b.world(), a.world())
})

test("contacts: sprinting into a parked car does not knock the player down", () => {
  // 5 m behind the car along screen-up, sprinting straight into it (the player then slides around it).
  const { up } = screenAxes(0)
  const from = { x: ON_BATTISTI.x - up.x * 5, y: ON_BATTISTI.y - up.y * 5, angle: 0 }
  assert.ok(walkClear(from))
  const { run, view } = start([{ frame: 0, press: ["up", "sprint"] }], [from, { cars: [parkedCar("panda", 0xb8312b, ON_BATTISTI)] }])
  const modes = new Set<string>()
  let closest = Number.MAX_VALUE
  run(120, () => {
    modes.add(view()!.mode)
    closest = Math.min(closest, Vec2.distance(view()!.pose, ON_BATTISTI))
  })
  assert.ok(closest < 1.3, `ran into the car: ${closest}`)
  assert.deepEqual([...modes], ["foot"])
})

test("enter: the marble truck can be entered from beside its cab, 3.5 m from its centre", () => {
  const { length } = VEHICLES.truck
  const cab = { x: ON_BATTISTI.x + Ops.cos(ON_BATTISTI.angle) * (length / 2 - 0.5), y: ON_BATTISTI.y + Ops.sin(ON_BATTISTI.angle) * (length / 2 - 0.5) }
  const at = { ...door({ ...ON_BATTISTI, ...cab }, 1), angle: 0 }
  assert.ok(Vec2.distance(at, ON_BATTISTI) > 3.5 && walkClear(at))
  const { run, view } = start(press(0, "action"), [at, { cars: [parkedCar("truck", 0xd4a85e, ON_BATTISTI)] }])
  run(1)
  assert.equal(view()?.mode, "driving")
})
