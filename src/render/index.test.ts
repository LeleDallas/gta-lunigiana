import assert from "node:assert/strict"
import { test } from "node:test"

import { Group } from "three"

import { lintTarget } from "../sim/index.ts"
import { PersonNode, vehicleNode } from "./actors.ts"
import { solidMaterial } from "./geometry.ts"
import { makeRegistries } from "./index.ts"

// Regression: detached vehicle nodes kept their x-ray geometry, so despawned traffic leaked GPU buffers.
test("registries: a detached node frees its own geometry, not its vehicle's shared body", () => {
  const { people, vehicles } = makeRegistries(new Group())
  const car = vehicles.ensure(1, () => vehicleNode("panda", 0xb8312b, solidMaterial))
  const person = people.ensure(2, () => new PersonNode({ skin: 0xe7b896, hair: 0x2b1d14, shirt: 0xf0c93c, pants: 0x1d2b4f }, solidMaterial))
  const freed = new Set<string>()
  const watch = (name: string, geometry: { addEventListener: (type: "dispose", listener: () => void) => void }) =>
    geometry.addEventListener("dispose", () => freed.add(name))
  watch("car x-ray", car.xray.geometry)
  watch("car body", car.body.geometry)
  watch("person x-ray", person.xray.geometry)
  person.frames.forEach((frame, i) => watch(`frame ${i}`, frame))
  assert.ok(vehicles.remove(1) && people.remove(2))
  assert.deepEqual([...freed].sort(), ["car x-ray", "frame 0", "frame 1", "frame 2", "person x-ray"])
  assert.equal(car.parent, null)
})

test("the host schedules (render, audio) read the world and never write it", async () => {
  const { runtime, schedules, describe = {} } = await lintTarget()
  runtime.debug.nameSchedules({ ...schedules, ...describe })
  const described = runtime.debug.describe()
  assert.deepEqual(Object.keys(describe), ["render", "audio"])
  for (const name of Object.keys(describe)) {
    const steps = described.schedules.find((s) => s.name === name)?.steps ?? []
    const names = steps.flatMap((step) => (step.kind === "system" ? [step.system] : []))
    const systems = described.systems.filter((s) => names.includes(s.name))
    if (name === "render") assert.equal(systems.length, 5)
    assert.ok(systems.length > 0, `${name} has systems`)
    for (const s of systems) {
      const writes = [...s.queries.flatMap((q) => q.writes), ...s.resources.writes, ...s.events.writes, ...Object.values(s.commands).flat()]
      assert.deepEqual(writes, [], `${s.name} writes the world`)
    }
  }
})
