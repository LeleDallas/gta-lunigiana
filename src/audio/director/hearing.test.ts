import assert from "node:assert/strict"
import { test } from "node:test"

import { heightAt } from "../../sim/map/index.ts"
import { CABIN, type Cabin, EAR_HEIGHT } from "../acoustics.ts"
import { hear } from "./hearing.ts"

/** A treeless meadow on Monte dei Bianchi, clear for 300 m to the south. */
const MEADOW = { x: -329, y: 1078 }
const ears = { ...MEADOW, z: heightAt(MEADOW.x, MEADOW.y) + EAR_HEIGHT, vx: 0, vy: 0 }

/** The reverb send of a car `metres` south, with the listener in a street `street` 0…1 and maybe a cabin. */
const wet = (metres: number, street: number, cabin?: Cabin) => {
  const source = { x: MEADOW.x, y: MEADOW.y - metres, z: heightAt(MEADOW.x, MEADOW.y - metres) + 0.8 }
  return hear({ ears, source, db: 90, rMin: 2, delta: 0, forest: 0, ambient: 35, street, cabin }).placement.wet
}

test("the reverb send rises with distance (the direct sound falls, the reverberant field stays), in a street, and drops in a cabin", () => {
  assert.ok(wet(5, 0) < wet(20, 0) && wet(20, 0) < wet(40, 0))
  assert.equal(wet(40, 0), wet(200, 0), "capped")
  assert.ok(wet(20, 0) < wet(20, 1))
  assert.ok(wet(20, 0, CABIN.panda) < wet(20, 0))
})
