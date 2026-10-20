/**
 * The render schedule: mirrors people and vehicles into three nodes with RenderSync, places them
 * between fixed steps (PrevPose → Pose at the loop's alpha) on the ground or road under them, and
 * marks the player's car for the x-ray silhouette. Read-only towards the world (index.test.ts
 * checks every system's declared access); the host ticks it once per animation frame after writing
 * `RenderClock.alpha`.
 *
 * @module render
 */
import { Descriptor } from "@typeonce/ritmo"
import { NodeRegistry, RenderSync } from "@typeonce/ritmo-render"
import type { Object3D } from "three"

import { wrapAngle } from "../sim/body.ts"
import { Down, Driving, Game, Person, Player, Pose, type PoseValue, PrevPose, Vehicle } from "../sim/index.ts"
import { ActorNode, PersonNode, vehicleNode } from "./actors.ts"
import { solidMaterial } from "./geometry.ts"
import { groundY } from "./ground.ts"

/** Person nodes, one per entity with a Person. */
export const People = Descriptor.Service<NodeRegistry.NodeRegistry<PersonNode>>()("Lunigiana/PeopleNodes")
/** Vehicle nodes, one per entity with a Vehicle. */
export const Vehicles = Descriptor.Service<NodeRegistry.NodeRegistry<ActorNode>>()("Lunigiana/VehicleNodes")
/** Mutable host object: the loop writes `alpha` (fraction of a step since the last one) before ticking `render`. */
export const RenderClock = Descriptor.Service<{ readonly alpha: number }>()("Lunigiana/RenderClock")

/** The two registries, attaching nodes under `parent` and freeing them on detach. */
export const makeRegistries = (parent: Object3D) => {
  const options = {
    attach: (node: ActorNode) => parent.add(node),
    detach: (node: ActorNode) => {
      node.removeFromParent()
      node.dispose()
    }
  }
  return { people: NodeRegistry.make<PersonNode>(options), vehicles: NodeRegistry.make<ActorNode>(options) }
}

const SyncPeople = RenderSync.system(Game, {
  name: "Lunigiana/SyncPeople",
  renderable: Person,
  registry: People,
  select: { driving: Game.Query.optional(Driving), down: Game.Query.optional(Down), player: Game.Query.optional(Player) },
  // PrevPose is written every step, so apply also sees Driving and Down going away.
  redrawOn: [Driving, Down, PrevPose],
  create: ({ renderable }) => new PersonNode(renderable, solidMaterial),
  apply: (node, { data }) => {
    node.visible = !data.driving.present
    node.rotation.z = data.down.present ? -Math.PI / 2 : 0
    node.xray.visible = data.player.present
  }
})

const SyncVehicles = RenderSync.system(Game, {
  name: "Lunigiana/SyncVehicles",
  renderable: Vehicle,
  registry: Vehicles,
  create: ({ renderable }) => vehicleNode(renderable.model, renderable.color, solidMaterial),
  apply: () => {}
})

/** Shows the x-ray silhouette of the vehicle the player drives, and only that one. */
const MarkDriven = Game.System("Lunigiana/MarkDriven", {
  queries: {
    player: Game.Query({ selection: { driving: Game.Query.optional(Driving) }, with: [Player] }),
    vehicles: Game.Query({ selection: { vehicle: Game.Query.read(Vehicle) } })
  },
  services: { nodes: Game.System.service(Vehicles) }
}, ({ queries, services }) => {
  const found = queries.player.singleOptional()
  const driving = found.ok ? found.value?.data.driving.value() : undefined
  const car = driving === undefined ? undefined : queries.vehicles.getHandle(driving.vehicle)
  const driven: number | undefined = car?.ok === true ? car.value.entity.id : undefined
  for (const [entity, node] of services.nodes.entries()) node.xray.visible = entity === driven
})

/** `from` → `to` at `alpha`, turning the short way round. */
export const blend = (from: PoseValue, to: PoseValue, alpha: number): PoseValue => ({
  x: from.x + (to.x - from.x) * alpha,
  y: from.y + (to.y - from.y) * alpha,
  angle: from.angle + wrapAngle(to.angle - from.angle) * alpha
})

const STRIDE = 0.45 // metres per walk frame
const PlacePeople = RenderSync.interpolate(Game, {
  name: "Lunigiana/PlacePeople",
  registry: People,
  previous: PrevPose,
  current: Pose,
  clock: RenderClock,
  blend,
  place: (node, { x, y, angle }) => {
    const h = groundY(x, y, node.elevation)
    node.elevation = h
    node.position.set(x, h + (node.rotation.z === 0 ? 0 : 0.2), -y)
    node.rotation.y = angle
    const moved = node.last === undefined ? 0 : Math.hypot(x - node.last.x, y - node.last.y)
    node.last = { x, y }
    node.walked += moved
    node.body.geometry = moved < 1e-3 || node.rotation.z !== 0 ? node.frames[0] : node.frames[Math.floor(node.walked / STRIDE) % 2 === 0 ? 1 : 2]
  }
})

const PlaceVehicles = RenderSync.interpolate(Game, {
  name: "Lunigiana/PlaceVehicles",
  registry: Vehicles,
  previous: PrevPose,
  current: Pose,
  clock: RenderClock,
  blend,
  place: (node, { x, y, angle }) => {
    const dx = (Math.cos(angle) * node.length) / 2, dy = (Math.sin(angle) * node.length) / 2
    const front = groundY(x + dx, y + dy, node.elevation), rear = groundY(x - dx, y - dy, node.elevation)
    node.elevation = (front + rear) / 2
    node.position.set(x, node.elevation, -y)
    node.rotation.y = angle
    node.rotation.z = Math.atan2(front - rear, node.length)
  }
})

/** The render schedule, ticked once per animation frame after the fixed updates. */
export const render = Game.Schedule(SyncPeople, SyncVehicles, MarkDriven, PlacePeople, PlaceVehicles)
