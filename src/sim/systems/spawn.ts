import { Random, Vec2 } from "@typeonce/ritmo-math"

import { carClear } from "../body.ts"
import { graph, MAP, roadClassOf } from "../map/index.ts"
import { nearestEdge, roadOf } from "../route.ts"
import { CarInput, Game, Motion, Person, Player, Pose, PrevPose, Rng, Vehicle } from "../schema.ts"
import { parkedCar, randomColor } from "../spawning.ts"

const PARKED = 45
const TRUCKS = 2
const CARABINIERI_BLUE = 0x1d2b4f

const police = MAP.pois.find((p) => p.kind === "amenity=police")
const byPolice = police === undefined ? [] : [...MAP.spawns.parked]
  .sort((a, b) => Vec2.distanceSquared(a, police) - Vec2.distanceSquared(b, police))
  .slice(0, 2)
const civilian = MAP.spawns.parked.filter((s) => !byPolice.includes(s))
const onTertiary = (s: Vec2.Vec2) =>
  roadClassOf(roadOf(nearestEdge(graph.trafficEdges, s.x, s.y))) === "tertiary"

/** Setup: the player at the map spawn, the Carabinieri at their station, and parked cars picked with the world's Rng. */
export const SpawnWorld = Game.System("Lunigiana/SpawnWorld", {
  resources: { rng: Game.System.writeResource(Rng) },
  commands: Game.System.commands(Game.System.spawns(Player, Person, Pose, PrevPose, Motion, Vehicle, CarInput))
}, ({ resources, commands }) => {
  const random = Random.draw(resources.rng)
  const start = MAP.spawns.player
  commands.spawn(Game.Command.spawn(
    [Player, {}],
    [Pose, start],
    [PrevPose, start],
    [Motion, { vx: 0, vy: 0, spin: 0 }],
    [Person, { skin: 0xe7b896, hair: 0x2b1d14, shirt: 0xf0c93c, pants: 0x1d2b4f }]
  ))
  for (const spot of byPolice) commands.spawn(parkedCar("carabinieri", CARABINIERI_BLUE, spot))
  let trucks = 0
  for (const spot of random.shuffle(civilian).slice(0, PARKED - byPolice.length)) {
    const roll = random.next()
    const truck = trucks < TRUCKS && roll < 0.1 && onTertiary(spot) && carClear("truck", spot)
    if (truck) trucks++
    const model = truck ? "truck" : roll < 0.8 ? "panda" : "ape"
    commands.spawn(parkedCar(model, randomColor(random), spot))
  }
})
