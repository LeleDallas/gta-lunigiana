/**
 * What the map around the listener sounds like: the surface under a foot or a tyre, the mix of
 * forest, open ground and village (the ambience beds), how enclosed a street is (the reverb send),
 * forest along a path (foliage loss), rock faces that echo, and the fixed places that make
 * sound: church bells, farm dogs, birds in the trees. Running water is in places/water.ts.
 * Off the roads everything reads the renderer's land-cover raster (`mapCover`, built once and
 * shared); the other structures are built on their first query.
 *
 * @module audio/places
 */
import { coverName, mapCover, type Cover } from "../render/landcover.ts"
import { staticGrid } from "../sim/collide.ts"
import { buildingBoxes, buildingsIn, buildingStyleOf, districtAt, heightAt, MAP, type Road, treesIn } from "../sim/map/index.ts"
import { hash01, segDist2 } from "../tools/geometry.ts"
import { delayOf, EAR_HEIGHT, panOf } from "./acoustics.ts"
import type { Surface } from "./types.ts"

export { waterNear, type WaterHeard } from "./places/water.ts"

const { cell, x0, y0 } = MAP.heightmap, COLS = MAP.heightmap.cols - 1, ROWS = MAP.heightmap.rows - 1

/** The land cover of the 4 m cell under (x, y), clamped to the map. */
const coverAt = (x: number, y: number): Cover => {
  const i = Math.min(COLS - 1, Math.max(0, Math.floor((x - x0) / cell))), j = Math.min(ROWS - 1, Math.max(0, Math.floor((y - y0) / cell)))
  return coverName(mapCover()[j * COLS + i]!)
}

/**
 * Off the road, by land cover, as the terrain is painted: green covers are grass (scrub's brush is leaves), grey ones hard
 * (loose stones are gravel; bare rock, quarry floors and village paving are stone).
 */
const COVER_SURFACE = {
  meadow: "grass", forest: "leaves", grassland: "grass", scrub: "leaves", sparse: "gravel", scree: "gravel", rock: "stone", quarry: "stone",
  residential: "grass", farmland: "grass", farmyard: "dirt", vineyard: "grass", park: "grass", school: "grass", cemetery: "gravel",
  pitch: "grass", parking: "asphalt", industrial: "asphalt", paved: "stone", platform: "asphalt", ruins: "stone", pebble: "gravel"
} as const satisfies Record<Cover, Surface>

/** The roads' OSM `surface` values; anything else is asphalt. */
const ROAD_SURFACE: Partial<Record<string, Surface>> = {
  asphalt: "asphalt", paved: "asphalt", concrete: "asphalt", cement: "asphalt",
  cobblestone: "stone", sett: "stone", paving_stones: "stone", pebblestone: "stone", unhewn_cobblestone: "stone", stone: "stone",
  gravel: "gravel", fine_gravel: "gravel", compacted: "gravel",
  dirt: "dirt", ground: "dirt", earth: "dirt", unpaved: "dirt", mud: "dirt", grass: "dirt"
}

/** A foot or a wheel this far past a carriageway's edge is still on the road, m. */
const VERGE = 0.5

/** Every road segment (flat ax, ay, bx, by) with its road, gridded by its carriageway's box. */
const indexRoads = () => {
  const segs: Array<number> = [], road: Array<number> = []
  MAP.roads.forEach(({ pts }, k) => {
    for (let i = 0; i + 3 < pts.length; i += 2) {
      segs.push(pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!)
      road.push(k)
    }
  })
  const near = staticGrid(road.length, (i) => {
    const reach = MAP.roads[road[i]!]!.w / 2 + VERGE
    const ax = segs[4 * i]!, ay = segs[4 * i + 1]!, bx = segs[4 * i + 2]!, by = segs[4 * i + 3]!
    return [Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach]
  }, 32)
  return { segs, road, near }
}
let roads: ReturnType<typeof indexRoads> | undefined

/** What a foot or a tyre at (x, y) is on: the road whose carriageway it is deepest inside, else the land cover. */
export const surfaceAt = (x: number, y: number): Surface => {
  const { segs, road, near } = (roads ??= indexRoads())
  let deepest = 0, on: Road | undefined
  near(x, y, x, y, (i) => {
    const r = MAP.roads[road[i]!]!
    const depth = r.w / 2 + VERGE - Math.sqrt(segDist2(x, y, segs[4 * i]!, segs[4 * i + 1]!, segs[4 * i + 2]!, segs[4 * i + 3]!).d2)
    if (depth >= deepest) [deepest, on] = [depth, r]
  })
  return on === undefined ? COVER_SURFACE[coverAt(x, y)] : (ROAD_SURFACE[on.surface] ?? "asphalt")
}

/** Shares 0…1 of the ground around a point: woods, open grass, scrub and fields, village (river beds and bare stone count as none). */
interface Ambience { readonly forest: number; readonly open: number; readonly built: number }

const AMBIENCE = {
  meadow: "open", forest: "forest", grassland: "open", scrub: "open", sparse: "open", scree: "none", rock: "none", quarry: "none",
  residential: "built", farmland: "open", farmyard: "open", vineyard: "open", park: "open", school: "built", cemetery: "open",
  pitch: "open", parking: "built", industrial: "built", paved: "built", platform: "built", ruins: "open", pebble: "none"
} as const satisfies Record<Cover, keyof Ambience | "none">

/** An ambience cell is this many cover cells a side (32 m). */
const BLOCK = 8

/** The ambience shares of every 32 m block of the cover raster. */
const gridAmbience = () => {
  const cols = Math.ceil(COLS / BLOCK), rows = Math.ceil(ROWS / BLOCK), raster = mapCover()
  const shares = { forest: new Float32Array(cols * rows), open: new Float32Array(cols * rows), built: new Float32Array(cols * rows) }
  const kinds = Array.from({ length: 256 }, (_, v) => AMBIENCE[coverName(v)])
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
    const kind = kinds[raster[j * COLS + i]!]!
    if (kind !== "none") shares[kind][Math.floor(j / BLOCK) * cols + Math.floor(i / BLOCK)]! += 1
  }
  for (let k = 0; k < cols * rows; k++) {
    const i = k % cols, j = Math.floor(k / cols)
    // Blocks on the north and east edges are cut short.
    const n = (Math.min(COLS, (i + 1) * BLOCK) - i * BLOCK) * (Math.min(ROWS, (j + 1) * BLOCK) - j * BLOCK)
    for (const share of [shares.forest, shares.open, shares.built]) share[k]! /= n
  }
  return { cols, rows, shares }
}
let ambience: ReturnType<typeof gridAmbience> | undefined

/** The ambience around (x, y): the 32 m blocks' shares, bilinear between block centres. */
export const ambienceAt = (x: number, y: number): Ambience => {
  const { cols, rows, shares } = (ambience ??= gridAmbience()), size = cell * BLOCK
  const fx = Math.min(cols - 1, Math.max(0, (x - x0) / size - 0.5)), fy = Math.min(rows - 1, Math.max(0, (y - y0) / size - 0.5))
  const i = Math.min(cols - 2, Math.floor(fx)), j = Math.min(rows - 2, Math.floor(fy)), tx = fx - i, ty = fy - j, k = j * cols + i
  const at = (a: Float32Array) => {
    const south = a[k]! + (a[k + 1]! - a[k]!) * tx, north = a[k + cols]! + (a[k + cols + 1]! - a[k + cols]!) * tx
    return south + (north - south) * ty
  }
  return { forest: at(shares.forest), open: at(shares.open), built: at(shares.built) }
}

/** Facades are looked for in `PROBES` directions up to `PROBE_REACH` m; one `FULL_FACADE` m above the listener's ground counts fully. */
const PROBES = 8, PROBE_REACH = 15, FULL_FACADE = 4
const probeX = Array.from({ length: PROBES }, (_, k) => Math.cos((2 * Math.PI * k) / PROBES))
const probeY = Array.from({ length: PROBES }, (_, k) => Math.sin((2 * Math.PI * k) / PROBES))

/** How enclosed (x, y) is, 0 (open) … 1 (a narrow stone street): the share of directions that meet a facade within 15 m, by its height. */
export const streetAt = (x: number, y: number): number => {
  const nearest = new Float64Array(PROBES).fill(PROBE_REACH), weight = new Float64Array(PROBES), ground = heightAt(x, y)
  const ring = (pts: ReadonlyArray<number>, w: number) => {
    for (let i = 0, n = pts.length, j = n - 2; i < n; j = i, i += 2) {
      const px = pts[j]! - x, py = pts[j + 1]! - y, ex = pts[i]! - pts[j]!, ey = pts[i + 1]! - pts[j + 1]!
      for (let k = 0; k < PROBES; k++) {
        const den = probeX[k]! * ey - probeY[k]! * ex
        if (den === 0) continue
        const t = (px * ey - py * ex) / den, u = (px * probeY[k]! - py * probeX[k]!) / den
        if (t >= 0 && t < nearest[k]! && u >= 0 && u <= 1) [nearest[k], weight[k]] = [t, w]
      }
    }
  }
  buildingsIn(x - PROBE_REACH, y - PROBE_REACH, x + PROBE_REACH, y + PROBE_REACH, (i) => {
    const { z0, h, outer, holes } = MAP.buildings[i]!, w = Math.min(1, Math.max(0, z0 + h - ground) / FULL_FACADE)
    ring(outer, w)
    for (const hole of holes ?? []) ring(hole, w)
  })
  return weight.reduce((sum, w) => sum + w, 0) / PROBES
}

/** Forest along a path is sampled every this many metres. */
const FOREST_STEP = 8

/** Metres of forest on the straight path from (ax, ay) to (bx, by), for `foliageLoss`. */
export const forestAlong = (ax: number, ay: number, bx: number, by: number): number => {
  const length = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(length / FOREST_STEP))
  let forest = 0
  for (let k = 0; k < n; k++) if (coverAt(ax + ((bx - ax) * (k + 0.5)) / n, ay + ((by - ay) * (k + 0.5)) / n) === "forest") forest++
  return (forest * length) / n
}

/** A discrete echo of a loud sound off a rock face: seconds after the direct sound, dB below its 1 m level, and where it comes from. */
export interface Echo { readonly delay: number; readonly loss: number; readonly pan: number }

/** Echoing faces are searched in `AZIMUTHS` directions from `ECHO_NEAR` to `ECHO_FAR` m every `ECHO_STEP` m (physics.md §7: distinct echoes from 17 m on). */
const AZIMUTHS = 16, ECHO_NEAR = 40, ECHO_FAR = 400, ECHO_STEP = 8
/** A face is bare rock, as painted: it climbs at least this steeply (50°; a gentler slope sends sound to the sky) and stands this many metres above the ears. */
const FACE_SLOPE = 1.2, FACE_RISE = 10
/** Reflection loss of a rock face, dB (a cliff scatters more than it mirrors: Pieren and Wunderli 2011), and air absorption at 1 kHz, dB/m (ISO 9613-1, 15 °C / 70 %). */
const ROCK_DB = 10, AIR_DB = 0.0041

/**
 * Up to two echoes at (x, y), strongest first, from rock faces 40–400 m away that the listener can
 * see, at least 45° apart: delay 2d/c, loss 20·log10(2d) + air absorption + reflection loss. Empty
 * where no rock is in sight (buildings are not searched).
 */
export const echoesAt = (x: number, y: number): ReadonlyArray<Echo> => {
  const ear = heightAt(x, y) + EAR_HEIGHT, faces: Array<{ readonly k: number; readonly d: number; readonly dx: number; readonly dy: number; readonly loss: number }> = []
  for (let k = 0; k < AZIMUTHS; k++) {
    const ux = Math.cos((2 * Math.PI * k) / AZIMUTHS), uy = Math.sin((2 * Math.PI * k) / AZIMUTHS)
    // The steepest sight line so far: a face is heard only if it rises above it.
    let horizon = -Number.MAX_VALUE, previous = heightAt(x, y)
    for (let d = ECHO_STEP; d <= ECHO_FAR; d += ECHO_STEP) {
      const z = heightAt(x + ux * d, y + uy * d), slope = (z - previous) / ECHO_STEP, sight = (z - ear) / d
      previous = z
      if (d >= ECHO_NEAR && sight >= horizon && slope >= FACE_SLOPE && z - ear >= FACE_RISE) {
        faces.push({ k, d, dx: ux * d, dy: uy * d, loss: 20 * Math.log10(2 * d) + AIR_DB * 2 * d + ROCK_DB })
        break
      }
      horizon = Math.max(horizon, sight)
    }
  }
  faces.sort((a, b) => a.loss - b.loss)
  const apart = (a: number, b: number) => Math.min(Math.abs(a - b), AZIMUTHS - Math.abs(a - b)) >= AZIMUTHS / 8
  const first = faces[0], second = faces.find((f) => first !== undefined && apart(f.k, first.k))
  return [first, second].filter((f) => f !== undefined).map(({ d, dx, dy, loss }) => ({ delay: delayOf(2 * d), loss, pan: panOf(dx, dy) }))
}

/** A church bell: its tower top and the prime partial of its bell, Hz. */
export interface Bell { readonly key: string; readonly x: number; readonly y: number; readonly z: number; readonly pitch: number }

/** Taller towers hang bigger bells: the prime falls an octave from 800 Hz (a 10 m tower) to 400 Hz (30 m). */
const pitchOf = (h: number): number => 800 * 2 ** -Math.min(1, Math.max(0, (h - 10) / 20))

/** The tallest church or tower of every district that has one. */
const findBells = (): Array<Bell> => {
  const tallest = new Map<string, number>()
  MAP.buildings.forEach((b, i) => {
    const style = buildingStyleOf(b)
    if (style !== "church" && style !== "tower") return
    const [bx0, by0, bx1, by1] = buildingBoxes[i]!, district = districtAt((bx0 + bx1) / 2, (by0 + by1) / 2).name, best = tallest.get(district)
    if (best === undefined || b.h > MAP.buildings[best]!.h) tallest.set(district, i)
  })
  return [...tallest.values()].map((i) => {
    const { id, z0, h } = MAP.buildings[i]!, [bx0, by0, bx1, by1] = buildingBoxes[i]!
    return { key: `bell:${id}`, x: (bx0 + bx1) / 2, y: (by0 + by1) / 2, z: z0 + h, pitch: pitchOf(h) }
  })
}
/** One bell per settlement. */
export const bells: ReadonlyArray<Bell> = findBells()

/** A farm dog in a yard. */
export interface Dog { readonly key: string; readonly x: number; readonly y: number; readonly z: number; readonly big: boolean }

/** Buildings with a dog: about one in `DOG_SHARE` of these kinds, out of the village cores, with open ground `YARD` m out. */
const KENNELS: ReadonlySet<string> = new Set(["barn", "shed", "house", "farm_auxiliary"])
const DOG_SHARE = 8, YARD = 5
const YARD_COVERS: ReadonlySet<Cover> = new Set(["meadow", "grassland", "farmland", "farmyard"])

/** Every dog: hashed picks among the kennel buildings, placed in the first open yard probed around the building. */
const findDogs = (): Array<Dog> => {
  const out: Array<Dog> = []
  MAP.buildings.forEach(({ id, kind }, i) => {
    if (!KENNELS.has(kind) || hash01(id, 1) * DOG_SHARE >= 1) return
    const [bx0, by0, bx1, by1] = buildingBoxes[i]!, cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2
    const probes = [[bx0 - YARD, cy], [cx, by0 - YARD], [bx1 + YARD, cy], [cx, by1 + YARD]] as const
    const covers = probes.map(([px, py]) => coverAt(px, py))
    const yard = covers.findIndex((c) => YARD_COVERS.has(c))
    if (covers.includes("paved") || yard < 0) return
    const [x, y] = probes[yard]!
    out.push({ key: `dog:${id}`, x, y, z: heightAt(x, y) + 0.5, big: hash01(id, 2) < 0.5 })
  })
  return out
}
let dogs: ReadonlyArray<Dog> | undefined

/** The dogs within `radius` m of (x, y). */
export const dogsNear = (x: number, y: number, radius: number): ReadonlyArray<Dog> =>
  (dogs ??= findDogs()).filter((d) => (d.x - x) ** 2 + (d.y - y) ** 2 <= radius * radius)

/** Birds sing from trees `BIRD_NEAR` to `BIRD_FAR` m from the listener. */
const BIRD_NEAR = 15, BIRD_FAR = 70

/** A random tree 15–70 m from (x, y) for a bird to sing from, 6–12 m up; undefined where no tree is that near. */
export const birdSpot = (x: number, y: number, random: () => number): { readonly x: number; readonly y: number; readonly z: number } | undefined => {
  const { trees } = MAP
  let picked = -1, seen = 0
  treesIn(x - BIRD_FAR, y - BIRD_FAR, x + BIRD_FAR, y + BIRD_FAR, (i) => {
    const d2 = (trees[3 * i]! - x) ** 2 + (trees[3 * i + 1]! - y) ** 2
    // Reservoir sampling: every tree in the ring is equally likely, with no list.
    if (d2 >= BIRD_NEAR ** 2 && d2 <= BIRD_FAR ** 2 && random() * ++seen < 1) picked = i
  })
  if (picked < 0) return undefined
  const tx = trees[3 * picked]!, ty = trees[3 * picked + 1]!
  return { x: tx, y: ty, z: heightAt(tx, ty) + 6 + 6 * random() }
}
