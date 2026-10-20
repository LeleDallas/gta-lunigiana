/**
 * Route geometry on the map graph for traffic and pedestrians: lanes (edge
 * centreline offset to the right of travel by `side`), the next edge at a
 * node, and nearest-edge lookups. Static, derived once from `graph`.
 *
 * @module route
 */
import { Ops, type Random } from "@typeonce/ritmo-math"

import { carClear } from "./body.ts"
import { segmentDistance } from "./collide.ts"
import { graph, MAP, roadClassOf, type Road, type Segment } from "./map/index.ts"
import type { VehicleModel } from "./vehicles.ts"

/** An edge as travelled: start point, unit direction, length, and the right-hand normal. */
export interface Lane {
  readonly x: number
  readonly y: number
  readonly dx: number
  readonly dy: number
  readonly length: number
  /** Right of travel (x = east, y = north): (dy, −dx). */
  readonly rx: number
  readonly ry: number
}

/** The road an edge belongs to. */
export const roadOf = (edge: number): Road => MAP.roads[graph.edges[edge]!.road]!

/** Edge `edge` travelled a -> b when `forward`, else b -> a. */
export const laneOf = (edge: number, forward: boolean): Lane => {
  const e = graph.edges[edge]!
  const from = graph.nodes[forward ? e.a : e.b]!, to = graph.nodes[forward ? e.b : e.a]!
  const length = Math.max(e.length, 1e-6)
  const dx = (to.x - from.x) / length, dy = (to.y - from.y) / length
  return { x: from.x, y: from.y, dx, dy, length, rx: dy, ry: -dx }
}

/** The point `along` metres down the lane, `side` metres to its right. */
export const lanePoint = (lane: Lane, along: number, side: number) =>
  ({ x: lane.x + lane.dx * along + lane.rx * side, y: lane.y + lane.dy * along + lane.ry * side })

/** How far (x, y) has come along the lane (projection, unclamped). */
export const alongLane = (lane: Lane, x: number, y: number): number => (x - lane.x) * lane.dx + (y - lane.y) * lane.dy

/** The node a lane ends at. */
export const endNode = (edge: number, forward: boolean): number => (forward ? graph.edges[edge]!.b : graph.edges[edge]!.a)

/** Drive on the right: the nominal traffic lane offset for a road. */
const trafficSide = (road: Road): number => (road.w >= 5 ? road.w / 4 + 0.2 : 0.5)

/** Pedestrians keep to the verge of roads and to the middle of paths, steps and tracks. */
export const walkSide = (road: Road): number => {
  const cls = roadClassOf(road)
  return cls === "path" || cls === "steps" || cls === "track" ? 0.3 : road.w / 2 + 0.8
}

/** Cruising speed of AI traffic by road class, m/s. */
export const cruiseSpeed = (road: Road): number => {
  const cls = roadClassOf(road)
  return cls === "tertiary" ? 12 : cls === "unclassified" ? 9 : cls === "residential" ? 7 : 5
}

/** Trucks keep to the wide roads (lanes through the village arches are too narrow). */
const classAllows = (edge: number, model: VehicleModel): boolean => {
  if (model !== "truck") return true
  const cls = roadClassOf(roadOf(edge))
  return cls === "tertiary" || cls === "unclassified"
}

const walkSet: ReadonlySet<number> = new Set(graph.walkEdges)

/** Whether heading `angle` points along `edge` travelled a -> b (rather than b -> a). */
export const facesForward = (edge: number, angle: number): boolean => {
  const ab = laneOf(edge, true)
  return ab.dx * Ops.cos(angle) + ab.dy * Ops.sin(angle) >= 0
}

/** A choice of edge and direction leaving a node. */
export interface Step {
  readonly edge: number
  readonly forward: boolean
}

const leaving = (node: number, edge: number): Step => ({ edge, forward: graph.edges[edge]!.a === node })
const key = (step: Step) => step.edge * 2 + (step.forward ? 1 : 0)

/**
 * Peels degree-1 nodes off the edges `usable` allows until only loops (and
 * the paths between them) remain: the edges peeled, and for each the key of
 * its direction toward the node it was peeled at (into a dead end).
 */
const peel = (usable: (edge: number) => boolean) => {
  const degree = graph.adjacency.map((edges) => edges.filter(usable).length)
  const removed = new Set<number>()
  const toward = new Set<number>()
  const leaves = degree.flatMap((d, node) => (d === 1 ? [node] : []))
  for (let leaf = leaves.pop(); leaf !== undefined; leaf = leaves.pop()) {
    const edge = graph.adjacency[leaf]!.find((e) => usable(e) && !removed.has(e))
    if (edge === undefined) continue
    removed.add(edge)
    const e = graph.edges[edge]!
    const other = e.a === leaf ? e.b : e.a
    toward.add(key({ edge, forward: e.b === leaf }))
    if (--degree[other]! === 1) leaves.push(other)
  }
  return { removed, toward }
}

/** Trucks cannot turn round on these roads, so they keep to the loops of their network: every spur peeled off. */
const loopsOnly = (sides: Float64Array): Float64Array => {
  for (const edge of peel((e) => sides[e * 2]! >= 0).removed) sides.fill(-1, edge * 2, edge * 2 + 2)
  return sides
}

/** A car's body must clear the walls every LANE_SAMPLE metres along the middle 80% of a lane; its offset shrinks by SIDE_STEP until it does. */
const LANE_SAMPLE = 1.5
const SIDE_STEP = 0.25

/**
 * `sides` with only the largest connected part of its usable edges (≥ 0)
 * kept: where narrow roads cut a model's network in two, it keeps off the
 * smaller piece rather than bounce between its dead ends.
 */
const largestPart = (sides: Float64Array): Float64Array => {
  const usable = (edge: number) => sides[edge * 2]! >= 0
  const part = new Int32Array(graph.nodes.length).fill(-1)
  const sizes: Array<number> = []
  graph.nodes.forEach((_, seed) => {
    if (part[seed]! >= 0 || !graph.adjacency[seed]!.some(usable)) return
    const id = sizes.length
    const open = [seed]
    part[seed] = id
    let size = 0
    for (let node = open.pop(); node !== undefined; node = open.pop()) {
      size++
      for (const edge of graph.adjacency[node]!) {
        if (!usable(edge)) continue
        const e = graph.edges[edge]!
        const other = e.a === node ? e.b : e.a
        if (part[other]! < 0) {
          part[other] = id
          open.push(other)
        }
      }
    }
    sizes.push(size)
  })
  const main = sizes.indexOf(Math.max(...sizes))
  graph.edges.forEach((e, edge) => {
    if (usable(edge) && part[e.a] !== main) sides.fill(-1, edge * 2, edge * 2 + 2)
  })
  return sides
}

/**
 * Per model, the lane offset of each traffic edge and direction: the nominal
 * keep-right offset, shrunk toward the centreline until the body clears every
 * wall along the lane (houses that crowd one side of the road); −1 where it
 * does not fit even on the centreline, its class is off limits, or the edge
 * is cut off from the rest.
 */
const lanesFor = (model: VehicleModel): Float64Array => {
  const sides = new Float64Array(graph.edges.length * 2).fill(-1)
  for (const edge of graph.trafficEdges) for (const forward of [false, true]) {
    if (!classAllows(edge, model)) continue
    const lane = laneOf(edge, forward)
    const angle = Ops.atan2(lane.dy, lane.dx)
    const samples = Math.max(2, Math.ceil((lane.length * 0.8) / LANE_SAMPLE))
    const fits = (side: number) => {
      for (let i = 0; i <= samples; i++) if (!carClear(model, { ...lanePoint(lane, lane.length * (0.1 + (0.8 * i) / samples), side), angle })) return false
      return true
    }
    let side = trafficSide(roadOf(edge))
    while (side > 0 && !fits(side)) side = Math.max(0, side - SIDE_STEP)
    if (side > 0 || fits(0)) sides[key({ edge, forward })] = side
  }
  return largestPart(sides)
}
const laneSides = {
  panda: lanesFor("panda"), ape: lanesFor("ape"), truck: loopsOnly(lanesFor("truck")), carabinieri: lanesFor("carabinieri")
} satisfies Record<VehicleModel, Float64Array>

/** Drive on the right: the lane offset of `model` on `step` (nominal, or less where walls crowd the road). */
export const laneSide = (step: Step, model: VehicleModel): number => Math.max(0, laneSides[model][key(step)]!)

/** Whether AI `model` may drive `edge`: where the body fits between the walls, trucks only on the loops of the wide roads. */
export const allowsModel = (edge: number, model: VehicleModel): boolean =>
  laneSides[model][key({ edge, forward: true })]! >= 0 && laneSides[model][key({ edge, forward: false })]! >= 0

/** Per model, the directions of travel that only lead into dead-end spurs (map exits, and roads too narrow for it, included). */
const deadEnds = {
  panda: peel((e) => allowsModel(e, "panda")).toward,
  ape: peel((e) => allowsModel(e, "ape")).toward,
  truck: peel((e) => allowsModel(e, "truck")).toward,
  carabinieri: peel((e) => allowsModel(e, "carabinieri")).toward
} satisfies Record<VehicleModel, ReadonlySet<number>>

/** Whether travelling `edge` this way only leads `model` into a dead end. */
export const leadsToDeadEnd = (step: Step, model: VehicleModel): boolean => deadEnds[model].has(key(step))

/** Turns sharper than this (cosine between the directions in and out) are hairpins a car cannot follow. */
const HAIRPIN = -0.5

/**
 * The traffic edge to take after arriving at `node` along `arrived`: a random
 * legal one (oneway roads only a -> b, only roads the model fits), avoiding
 * dead-end spurs and then hairpins while there is another way on, and a
 * U-turn only at a dead end.
 */
export const nextTrafficEdge = (node: number, arrived: number, model: VehicleModel, random: Random.Random): Step => {
  const options = graph.adjacency[node]!
    .filter((e) => e !== arrived && allowsModel(e, model) && (roadOf(e).oneway !== true || graph.edges[e]!.a === node))
    .map((e) => leaving(node, e))
  const into = laneOf(arrived, graph.edges[arrived]!.b === node)
  const gentle = (step: Step) => {
    const out = laneOf(step.edge, step.forward)
    return into.dx * out.dx + into.dy * out.dy > HAIRPIN
  }
  const onward = options.filter((step) => !leadsToDeadEnd(step, model))
  const pool = [onward.filter(gentle), onward, options].find((tier) => tier.length > 0) ?? []
  return random.pick(pool) ?? leaving(node, arrived)
}

/** The walk edge to take after arriving at `node` along `arrived`: random, turning back only at dead ends. */
export const nextWalkEdge = (node: number, arrived: number, random: Random.Random): Step => {
  const options = graph.adjacency[node]!.filter((e) => e !== arrived && walkSet.has(e))
  return leaving(node, random.pick(options) ?? arrived)
}

/** Every graph edge as a segment a -> b, indexed like `graph.edges`. */
const chords: ReadonlyArray<Segment> = graph.edges.map((e) => {
  const a = graph.nodes[e.a]!, b = graph.nodes[e.b]!
  return { ax: a.x, ay: a.y, bx: b.x, by: b.y }
})

/** Distance from (x, y) to the centreline of `edge`. */
export const distanceToEdge = (edge: number, x: number, y: number): number => segmentDistance(chords[edge]!, x, y)

/** The edge of `edges` whose centreline is nearest to (x, y). */
export const nearestEdge = (edges: ReadonlyArray<number>, x: number, y: number): number => {
  let best = edges[0]!, distance = Number.MAX_VALUE
  for (const e of edges) {
    const d = distanceToEdge(e, x, y)
    if (d < distance) [best, distance] = [e, d]
  }
  return best
}

/** Midpoint of every graph edge, indexed like `graph.edges`. */
export const midpoints: ReadonlyArray<{ readonly x: number; readonly y: number }> = chords.map((c) => ({ x: (c.ax + c.bx) / 2, y: (c.ay + c.by) / 2 }))
