// OSM -> map features in local metres, clipped to the play area. Terrain-dependent
// fields (z, z0) are filled later by build-map.ts.
import type { Area, Barrier, Poi } from "../sim/map/index.ts"
import { type AreaKind, type BuildingStyle, isRoadClass, type RoadClass, ROADS } from "../sim/map/kinds.ts"
import { assembleRings, type Osm, type OsmWay, type Tags } from "./osm.ts"
import { clipLine, clipRing, flatLine, flatRing, hash01, inBounds, r1, toLocal, type P, type V } from "./geometry.ts"

export interface RoadF {
  readonly id: number
  readonly cls: RoadClass
  name?: string
  readonly ref?: string
  readonly w: number
  readonly surface: string
  readonly oneway?: true
  readonly bridge?: true
  readonly tunnel?: true
  readonly layer?: number
  /** OSM maxheight (m) of an underpass. */
  readonly maxheight?: number
  readonly private: boolean
  readonly pts: ReadonlyArray<V>
}
export interface WaterF { readonly id: number; readonly kind: "river" | "stream"; readonly name?: string; readonly w: number; readonly bed: number; readonly depth: number; readonly pts: ReadonlyArray<V> }
export interface RailF { readonly id: number; readonly bridge?: true; readonly tunnel?: true; readonly pts: ReadonlyArray<V> }
export interface BuildingF {
  readonly id: number
  readonly kind: string
  readonly name?: string
  readonly h: number
  readonly style: BuildingStyle
  readonly ruins?: true
  readonly tint: number
  readonly outer: ReadonlyArray<number>
  readonly holes?: ReadonlyArray<ReadonlyArray<number>>
}

const vertices = (osm: Osm, nds: ReadonlyArray<string>): Array<V> =>
  nds.map((id) => {
    const n = osm.nodes.get(id)!
    const [x, y] = toLocal(n.lat, n.lon)
    return { x, y, id }
  })
const ringOf = (osm: Osm, nds: ReadonlyArray<string>): Array<P> => vertices(osm, nds.slice(0, -1)).map((v) => [v.x, v.y])
const closed = (w: OsmWay) => w.nds.length > 3 && w.nds[0] === w.nds.at(-1)

export const extractRoads = (osm: Osm): Array<RoadF> => {
  const roads = [...osm.ways.values()].flatMap((w) => {
    const t = w.tags, cls = t.highway
    if (cls === undefined || !isRoadClass(cls)) return []
    return clipLine(vertices(osm, w.nds)).map((pts): RoadF => ({
      id: +w.id,
      cls,
      ...(t.name ? { name: t.name } : {}),
      ...(t.ref ? { ref: t.ref } : {}),
      w: ROADS[cls].w,
      surface: t.surface ?? (ROADS[cls].paved ? "asphalt" : "unpaved"),
      ...(t.oneway === "yes" ? { oneway: true } : {}),
      ...(t.bridge !== undefined && t.bridge !== "no" ? { bridge: true } : {}),
      ...(t.tunnel !== undefined && t.tunnel !== "no" ? { tunnel: true } : {}),
      ...(t.layer ? { layer: +t.layer } : {}),
      ...(t.maxheight !== undefined && !Number.isNaN(parseFloat(t.maxheight)) ? { maxheight: parseFloat(t.maxheight) } : {}),
      private: t.access === "private" || t.access === "no",
      pts
    }))
  })
  // Via Cesare Battisti exists only as addr:street on POIs: give each street name to the
  // unnamed road whose vertices are nearest to most of its addresses (prototype: way 48307396).
  const votes = new Map<string, Map<number, number>>()
  for (const n of osm.nodes.values()) {
    const street = n.tags["addr:street"]
    if (street === undefined) continue
    const [x, y] = toLocal(n.lat, n.lon)
    let best: RoadF | undefined, bestD = Number.MAX_VALUE
    for (const r of roads) for (const p of r.pts) {
      const d = Math.hypot(p.x - x, p.y - y)
      if (d < bestD) [best, bestD] = [r, d]
    }
    if (best === undefined || best.name !== undefined) continue
    const v = votes.get(street) ?? new Map<number, number>()
    v.set(best.id, (v.get(best.id) ?? 0) + 1)
    votes.set(street, v)
  }
  for (const [street, v] of votes) {
    const [id] = [...v].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!
    const name = street.startsWith("Via") ? street : `Via ${street}`
    for (const r of roads) if (r.id === id && r.name === undefined) r.name = name
  }
  return roads
}

export const extractWater = (osm: Osm): Array<WaterF> =>
  [...osm.ways.values()].filter((w) => w.tags.waterway !== undefined && w.tags.tunnel !== "culvert").flatMap((w) => {
    const t = w.tags
    const kind = t.waterway === "river" ? "river" : "stream"
    const lucido = t.name === "Torrente Lucido"
    const main = lucido || t.name === "Torrente Caldanella"
    const width = lucido && kind === "river" ? 14 : main ? 8 : t.name ? 4 : 2
    const bed = lucido && kind === "river" ? 11 : Math.max(width / 2 + 1, 3)
    const depth = kind === "river" ? 2.5 : main ? 1.5 : 1
    return clipLine(vertices(osm, w.nds)).map((pts): WaterF => ({ id: +w.id, kind, ...(t.name ? { name: t.name } : {}), w: width, bed, depth, pts }))
  })

export const extractRail = (osm: Osm): Array<RailF> =>
  [...osm.ways.values()].filter((w) => w.tags.railway === "rail").flatMap((w) =>
    clipLine(vertices(osm, w.nds)).map((pts): RailF => ({
      id: +w.id,
      ...(w.tags.bridge !== undefined && w.tags.bridge !== "no" ? { bridge: true } : {}),
      ...(w.tags.tunnel !== undefined && w.tags.tunnel !== "no" ? { tunnel: true } : {}),
      pts
    })))

const H_OVERRIDE: Record<string, number> = { "700766553": 20, "530307389": 12 } // 39 m bell tower and 27.7 m LiDAR church on a spur
/** Hill villages built in stone (x, y, r): Monzone Alto, Aiola (with its eastern houses), Castellaccio. */
const STONE_CORES: ReadonlyArray<readonly [number, number, number]> = [[-20, -300, 170], [720, 170, 220], [420, -260, 120]]
/** Generic buildings closer than this (m) form one cluster with one facade style. */
const CLUSTER_LINK = 25

const styleOf = (t: Tags, cx: number, cy: number): BuildingStyle => {
  if (t.ruins !== undefined || t.building === "ruins") return "ruin"
  if (t.building === "church" || t.amenity === "place_of_worship") return "church"
  if (t.building === "tower" || t.man_made === "tower") return "tower"
  if (t.building === "train_station") return "station"
  if (t.building === "industrial" || t.power !== undefined) return "industrial"
  return STONE_CORES.some(([x, y, r]) => Math.hypot(cx - x, cy - y) < r) ? "stone" : "plaster"
}

export const extractBuildings = (osm: Osm): Array<BuildingF> => {
  const rels = [...osm.relations.values()].filter((r) => r.tags.type === "multipolygon" && r.tags.building !== undefined)
  const inRel = new Set(rels.flatMap((r) => r.members.map((m) => m.ref)))
  const make = (id: string, t: Tags, outer: Array<P>, holes: Array<Array<P>>): BuildingF | undefined => {
    const o = flatRing(clipRing(outer), true)
    if (o === undefined) return undefined
    let cx = 0, cy = 0
    for (let i = 0; i < o.length; i += 2) [cx, cy] = [cx + (2 * o[i]!) / o.length, cy + (2 * o[i + 1]!) / o.length]
    const ruins = t.ruins !== undefined || t.building === "ruins"
    const tagged = t.height === undefined ? Number.NaN : parseFloat(t.height)
    const h = H_OVERRIDE[id] ?? (Number.isNaN(tagged) ? (ruins ? 2.5 : 6) : Math.min(Math.max(tagged, 2.5), 22))
    const hs = holes.map((r) => flatRing(clipRing(r), false)).filter((r) => r !== undefined)
    return {
      id: +id,
      kind: t.building === "yes" && t.amenity === "place_of_worship" ? "church" : t.building!,
      ...(t.name ? { name: t.name } : {}),
      h: r1(h),
      style: styleOf(t, cx, cy),
      ...(ruins ? { ruins: true } : {}),
      tint: Math.floor(hash01(+id % 1e9, 7) * 4),
      outer: o,
      ...(hs.length > 0 ? { holes: hs } : {})
    }
  }
  return unifyStyles([
    ...[...osm.ways.values()].filter((w) => w.tags.building !== undefined && !inRel.has(w.id) && closed(w)).map((w) => make(w.id, w.tags, ringOf(osm, w.nds), [])),
    ...rels.flatMap((r) => {
      const inner = assembleRings(osm, r, "inner").map((ring) => ringOf(osm, ring))
      return assembleRings(osm, r, "outer").map((ring) => make(r.id, r.tags, ringOf(osm, ring), inner))
    })
  ].filter((b) => b !== undefined))
}

/** Plaster/stone buildings within CLUSTER_LINK m of each other (single linkage) all take their cluster's majority style, so hamlets never split at a core radius. */
const unifyStyles = (bs: ReadonlyArray<BuildingF>): Array<BuildingF> => {
  const generic = bs.map((_, i) => i).filter((i) => bs[i]!.style === "plaster" || bs[i]!.style === "stone")
  const parent = bs.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!
    return i
  }
  const near = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
    for (let i = 0; i < a.length; i += 2) for (let j = 0; j < b.length; j += 2) if (Math.hypot(a[i]! - b[j]!, a[i + 1]! - b[j + 1]!) < CLUSTER_LINK) return true
    return false
  }
  for (const i of generic) for (const j of generic) if (i < j && find(i) !== find(j) && near(bs[i]!.outer, bs[j]!.outer)) parent[find(i)] = find(j)
  const stone = new Map<number, number>()
  for (const i of generic) stone.set(find(i), (stone.get(find(i)) ?? 0) + (bs[i]!.style === "stone" ? 1 : -1))
  return bs.map((b, i) => (generic.includes(i) ? { ...b, style: stone.get(find(i))! > 0 ? "stone" : "plaster" } : b))
}

const LANDUSE = ["cemetery", "vineyard", "farmland", "farmyard", "industrial", "residential", "forest"] as const satisfies ReadonlyArray<AreaKind>
const landuses: ReadonlySet<string> = new Set(LANDUSE)
const isLanduse = (landuse: string): landuse is (typeof LANDUSE)[number] => landuses.has(landuse)

const areaKind = (t: Tags): AreaKind | undefined => {
  if (t.landuse !== undefined && isLanduse(t.landuse)) return t.landuse
  if (t.leisure === "pitch" || t.leisure === "park") return t.leisure
  if (t.amenity === "parking" || t.amenity === "school") return t.amenity
  if (t.railway === "platform") return "platform"
  if (t.historic === "ruins" || t.historic === "archaeological_site") return "ruins"
  if (t.natural === "grassland") return "grassland"
  if (t.natural === "wood") return "forest"
  return undefined
}

/** Closed-way areas plus the forest/wood multipolygons (`full` = the relation files fetched with /full). */
export const extractAreas = (osm: Osm, full: ReadonlyArray<{ readonly osm: Osm; readonly id: string }>): Array<Area> => {
  const areas: Array<Area> = []
  for (const w of osm.ways.values()) {
    const kind = areaKind(w.tags)
    if (kind === undefined || w.tags.building !== undefined || !closed(w)) continue
    const ring = flatRing(clipRing(ringOf(osm, w.nds)), true)
    if (ring !== undefined) areas.push({ kind, ...(w.tags.name ? { name: w.tags.name } : {}), rings: [ring] })
  }
  for (const { osm: o, id } of full) {
    const rel = o.relations.get(id)!
    const holes = assembleRings(o, rel, "inner").map((r) => ringOf(o, r)).filter((r) => r.some(([x, y]) => inBounds(x, y)))
      .map((r) => flatRing(clipRing(r), false)).filter((r) => r !== undefined)
    for (const outer of assembleRings(o, rel, "outer")) {
      const ring = flatRing(clipRing(ringOf(o, outer)), true)
      if (ring !== undefined) areas.push({ kind: "forest", rings: [ring, ...holes] })
    }
  }
  return areas
}

export const extractBarriers = (osm: Osm): Array<Barrier> =>
  [...osm.ways.values()].filter((w) => w.tags.barrier === "wall" || w.tags.barrier === "guard_rail" || w.tags.natural === "cliff").flatMap((w) =>
    clipLine(vertices(osm, w.nds)).map((pts) => ({ kind: w.tags.natural === "cliff" ? "cliff" : w.tags.barrier!, pts: flatLine(pts) })))

const POI_KEYS = ["amenity", "shop", "tourism", "historic", "railway", "place", "leisure", "man_made", "natural", "highway"]

export const extractPois = (osm: Osm): Array<Poi> => {
  const pois: Array<Poi> = []
  for (const n of osm.nodes.values()) {
    const k = POI_KEYS.find((key) => n.tags[key] !== undefined)
    if (k === undefined || n.tags.tourism === "information" || n.tags.railway === "level_crossing" || n.tags.amenity === "bench") continue
    if (k === "highway" && n.tags.highway !== "trailhead") continue // crossings, stops, street lamps
    const [x, y] = toLocal(n.lat, n.lon)
    if (inBounds(x, y)) pois.push({ id: +n.id, kind: `${k}=${n.tags[k]}`, ...(n.tags.name ? { name: n.tags.name } : {}), x: r1(x), y: r1(y) })
  }
  // Named polygons (churches, cemetery, station...) as centroid POIs.
  for (const w of osm.ways.values()) {
    if (w.tags.name === undefined || !closed(w) || w.tags.highway !== undefined) continue
    const ring = ringOf(osm, w.nds)
    const x = ring.reduce((s, p) => s + p[0], 0) / ring.length, y = ring.reduce((s, p) => s + p[1], 0) / ring.length
    const kind = areaKind(w.tags) ?? w.tags.amenity ?? w.tags.building ?? "named"
    if (inBounds(x, y)) pois.push({ id: +w.id, kind: `area:${kind}`, name: w.tags.name, x: r1(x), y: r1(y) })
  }
  return pois
}
