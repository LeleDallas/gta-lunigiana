import assert from "node:assert/strict"
import { test } from "node:test"

import { locationAt } from "./location.ts"

test("the Carabinieri station is on Via Cesare Battisti, by the station", () => {
  assert.deepEqual(locationAt(-414.4, 433.1), { road: "Via Cesare Battisti", district: "Monzone (Stazione)" })
})

test("deep in the woods there is no road", () => {
  assert.equal(locationAt(300, -300).road, undefined)
})
