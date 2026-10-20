/**
 * Where the player is, in words: the nearest named road (tracks and paths skipped, their refs are
 * trail numbers) and the district from the map.
 *
 * @module hud/location
 */
import { districtAt, MAP, roadClassOf } from "../sim/map/index.ts"
import { segDist2 } from "../tools/geometry.ts"

/** A named stretch of road as segments `[ax, ay, bx, by, ...]`. */
interface Named { readonly name: string; readonly pts: ReadonlyArray<number> }

const named: ReadonlyArray<Named> = MAP.roads.flatMap((road): Array<Named> => {
  const cls = roadClassOf(road), name = road.name ?? road.ref
  return name === undefined || cls === "track" || cls === "path" ? [] : [{ name, pts: road.pts }]
})

/** The name of the nearest named road within `reach` metres of (x, y). */
// ponytail: brute force over ~1.3k segments per call; add a grid if it ever shows in a profile.
const roadNear = (x: number, y: number, reach = 15): string | undefined => {
  let best = reach * reach, found: string | undefined
  for (const road of named) for (let i = 0; i + 3 < road.pts.length; i += 2) {
    const d = segDist2(x, y, road.pts[i]!, road.pts[i + 1]!, road.pts[i + 2]!, road.pts[i + 3]!).d2
    if (d < best) [best, found] = [d, road.name]
  }
  return found
}

/** Road (if any) and district at (x, y). */
export const locationAt = (x: number, y: number): { readonly road: string | undefined; readonly district: string } =>
  ({ road: roadNear(x, y), district: districtAt(x, y).name })
