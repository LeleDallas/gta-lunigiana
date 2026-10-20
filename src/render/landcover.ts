/**
 * Land cover of every 4 m terrain cell: map areas rasterised with a scanline even-odd fill
 * (`fillPolygon`), meadow where nothing covers a cell, and pebble beds along rivers and streams.
 *
 * @module render/landcover
 */
import type { AreaKind, MonzoneMap } from "../sim/map/index.ts"
import { fillPolygon, segDist2 } from "../tools/geometry.ts"
import { PALETTE } from "./palette.ts"

/** Cover kinds: meadow by default, the map's area kinds, and the river bed. */
type Cover = "meadow" | AreaKind | "pebble"
/** Every cover, in fill order: later kinds draw over earlier ones. */
const COVERS = [
  "meadow", "forest", "grassland", "residential", "farmland", "farmyard", "vineyard", "park", "school",
  "cemetery", "pitch", "parking", "industrial", "platform", "ruins", "pebble"
] as const satisfies ReadonlyArray<Cover>

const coverIndex = new Map<string, number>(COVERS.map((c, i) => [c, i]))

/** Base colour, variant colour and the noise level under which a cell takes the variant (`stripes`: alternate columns). */
export interface CoverLook { readonly base: number; readonly alt: number; readonly share: number; readonly stripes?: boolean }

/** How each cover is painted. */
export const COVER_LOOK = {
  meadow: { base: PALETTE.grass, alt: PALETTE.grassDry, share: 0.3 },
  forest: { base: PALETTE.forestDark, alt: PALETTE.forest, share: 0.35 },
  grassland: { base: PALETTE.grassDry, alt: PALETTE.grass, share: 0.35 },
  residential: { base: PALETTE.grass, alt: PALETTE.grassDry, share: 0.3 },
  farmland: { base: PALETTE.grassDry, alt: PALETTE.dirtTrack, share: 0.5, stripes: true },
  farmyard: { base: PALETTE.dirtTrack, alt: PALETTE.grassDry, share: 0.3 },
  vineyard: { base: PALETTE.grass, alt: PALETTE.dirtTrack, share: 0.5, stripes: true },
  park: { base: PALETTE.grass, alt: PALETTE.forestLight, share: 0.25 },
  school: { base: PALETTE.grass, alt: PALETTE.asphaltWorn, share: 0.2 },
  cemetery: { base: PALETTE.plasterGrey, alt: PALETTE.stoneLight, share: 0.4 },
  pitch: { base: PALETTE.grass, alt: PALETTE.forestLight, share: 0.5, stripes: true },
  parking: { base: PALETTE.asphaltWorn, alt: PALETTE.asphalt, share: 0.2 },
  industrial: { base: PALETTE.asphaltWorn, alt: PALETTE.stoneMid, share: 0.3 },
  platform: { base: PALETTE.asphaltWorn, alt: PALETTE.asphaltWorn, share: 0 },
  ruins: { base: PALETTE.stoneMid, alt: PALETTE.forest, share: 0.4 },
  pebble: { base: PALETTE.limestone, alt: PALETTE.marbleWhite, share: 0.4 }
} as const satisfies Record<Cover, CoverLook>

/** Extra pebble bed beyond the water's half-width, by water width (m); narrow streams get none. */
const bankOf = (w: number): number => (w >= 12 ? 5 : w >= 8 ? 3 : w >= 4 ? 1.5 : 0)

/**
 * The cover of every terrain cell, row-major with row 0 = south, `(cols − 1) × (rows − 1)` cells
 * of the heightmap. Forest is filled first, so every other area and the river beds draw over it.
 */
export const rasterCover = (map: Pick<MonzoneMap, "heightmap" | "areas" | "water">): Uint8Array => {
  const { cell, x0, y0 } = map.heightmap
  const cols = map.heightmap.cols - 1, rows = map.heightmap.rows - 1
  const out = new Uint8Array(cols * rows)
  const ordered = [...map.areas].sort((a, b) => (coverIndex.get(a.kind) ?? 0) - (coverIndex.get(b.kind) ?? 0))
  for (const area of ordered) {
    const cover = coverIndex.get(area.kind)
    if (cover !== undefined) fillPolygon(area.rings, x0, y0, cell, cols, rows, (k) => (out[k] = cover))
  }
  const pebble = coverIndex.get("pebble")!
  for (const w of map.water) {
    const reach = w.w / 2 + bankOf(w.w)
    if (reach <= w.w / 2) continue
    for (let k = 0; k + 3 < w.pts.length; k += 2) {
      const ax = w.pts[k]!, ay = w.pts[k + 1]!, bx = w.pts[k + 2]!, by = w.pts[k + 3]!
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / cell)), i1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + reach - x0) / cell))
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - y0) / cell)), j1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) + reach - y0) / cell))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (segDist2(x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell, ax, ay, bx, by).d2 <= reach * reach) out[j * cols + i] = pebble
      }
    }
  }
  return out
}

/** The cover name of a raster value. */
export const coverName = (value: number): Cover => COVERS[value] ?? "meadow"
