// HUD district discs (`districtAt` in src/sim/map/index.ts): Monzone's named clusters, placed by
// hand, plus every OSM village and hamlet elsewhere, centred on its place node with a
// radius fitted to the buildings nearest it.
import type { District } from "../sim/map/index.ts"
import type { BuildingF } from "./features.ts"
import { centroid, inBounds, r1, toLocal } from "./geometry.ts"
import type { Osm } from "./osm.ts"

/** Monzone's station, streets and hill clusters: OSM names only Monzone (Alto) and Aiola there. */
const MONZONE: ReadonlyArray<District> = [
  { name: "Monzone (Stazione)", x: -500, y: 480, r: 250 },
  { name: "Via Riolo", x: -200, y: 310, r: 160 },
  { name: "Immacolata", x: -90, y: 120, r: 120 },
  { name: "Santa Lucia", x: 44.6, y: 223.8, r: 130 },
  { name: "Via per Equi", x: 260, y: 370, r: 190 },
  { name: "Caldanella", x: 570, y: 510, r: 110 },
  { name: "Cimitero", x: -45, y: -70, r: 70 },
  { name: "Monzone Alto", x: -34.4, y: -300.3, r: 170 },
  { name: "Collecchia", x: -140, y: -480, r: 100 },
  { name: "Torrignana", x: -398.7, y: -99.1, r: 200 },
  { name: "Aiola", x: 720, y: 190, r: 240 },
  { name: "Castello di Aiola", x: 420, y: -260, r: 110 },
  { name: "Novicchia", x: -924.1, y: -397.1, r: 220 },
  { name: "Acquanera", x: 117.2, y: -95.6, r: 120 }
]

/** Populated places only: a `locality` (a named hillside, a field) would claim the village's buildings around it. */
const PLACES: ReadonlySet<string> = new Set(["village", "hamlet"])
/** A building farther than this (m) from every place node is a farmhouse, no village's. */
const REACH = 600
/** Share of a place's buildings its disc covers; the rest are outliers. */
const FIT = 0.9
const RADIUS = { min: 80, max: 400 } // m

/**
 * MONZONE, then a disc per OSM place outside it, in node id order. Each building outside MONZONE
 * goes to the nearest place node within REACH; the disc covers FIT of them (plus 10 m), clamped
 * to RADIUS and rounded to 10 m.
 */
export const fitDistricts = (osm: Osm, buildings: ReadonlyArray<BuildingF>): Array<District> => {
  const inMonzone = (x: number, y: number) => MONZONE.some((d) => Math.hypot(x - d.x, y - d.y) <= d.r)
  const places = [...osm.nodes.values()].flatMap((n) => {
    const [x, y] = toLocal(n.lat, n.lon)
    const name = n.tags.name
    return PLACES.has(n.tags.place ?? "") && name !== undefined && inBounds(x, y) && !inMonzone(x, y) ? [{ name, x, y, near: [] as Array<number> }] : []
  })
  for (const b of buildings) {
    const [cx, cy] = centroid(b.outer)
    if (inMonzone(cx, cy)) continue
    let best: (typeof places)[number] | undefined, bestD = REACH
    for (const p of places) {
      const d = Math.hypot(p.x - cx, p.y - cy)
      if (d < bestD) [best, bestD] = [p, d]
    }
    best?.near.push(bestD)
  }
  return [...MONZONE, ...places.map(({ name, x, y, near }) => {
    near.sort((a, b) => a - b)
    const fit = (near[Math.floor(FIT * (near.length - 1))] ?? 0) + 10
    return { name, x: r1(x), y: r1(y), r: Math.round(Math.min(RADIUS.max, Math.max(RADIUS.min, fit)) / 10) * 10 }
  })]
}
