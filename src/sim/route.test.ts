import assert from "node:assert/strict"
import { test } from "node:test"

import { Ops } from "@typeonce/ritmo-math"

import { carClear } from "./body.ts"
import { graph } from "./map/index.ts"
import { allowsModel, laneOf, lanePoint, laneSide, leadsToDeadEnd } from "./route.ts"

test("dead ends: driving into a dead-end node is flagged, driving out of it is not", () => {
  let checked = 0
  graph.adjacency.forEach((edges, node) => {
    const own = edges.filter((e) => allowsModel(e, "panda"))
    if (own.length !== 1) return
    const into = { edge: own[0]!, forward: graph.edges[own[0]!]!.b === node }
    assert.ok(leadsToDeadEnd(into, "panda"))
    assert.ok(!leadsToDeadEnd({ edge: into.edge, forward: !into.forward }, "panda"))
    checked++
  })
  assert.ok(checked > 0)
})

// Regression: lanes a quarter of the road right of centre ran through houses that crowd the road (traffic wedged for minutes).
test("lanes: every lane AI traffic may drive keeps its body out of the walls", () => {
  for (const model of ["panda", "ape", "truck"] as const) {
    let lanes = 0
    for (const edge of graph.trafficEdges) for (const forward of [true, false]) {
      if (!allowsModel(edge, model)) continue
      const lane = laneOf(edge, forward)
      const angle = Ops.atan2(lane.dy, lane.dx)
      for (let f = 0.15; f < 0.9; f += 0.1) {
        const at = lanePoint(lane, lane.length * f, laneSide({ edge, forward }, model))
        assert.ok(carClear(model, { ...at, angle }, 0.05), `${model} on edge ${edge} (${forward ? "a -> b" : "b -> a"}) at ${f.toFixed(2)}`)
      }
      lanes++
    }
    assert.ok(lanes > 100, `${model}: ${lanes} lanes`)
  }
})
