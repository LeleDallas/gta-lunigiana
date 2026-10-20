/**
 * The terrain mesh: one faceted, vertex-coloured chunk per 128 m square, cut from the 4 m
 * heightmap (row 0 = south) and continued by an apron beyond the map bounds so the edges never
 * show the void. Cells take their land-cover colour; very steep faces show bare limestone.
 *
 * @module render/terrain
 */
import { BufferGeometry, Float32BufferAttribute } from "three"

import { MAP } from "../sim/map/index.ts"
import { hash01 } from "../tools/geometry.ts"
import { terrainNodeY } from "./ground.ts"
import { COVER_LOOK, coverName, type CoverLook } from "./landcover.ts"
import { linear } from "./geometry.ts"
import { PALETTE } from "./palette.ts"

const hm = MAP.heightmap
/** Cells per chunk side (32 × 4 m = 128 m). */
const CHUNK_CELLS = 32
/** Chunk side in metres. */
const CHUNK = CHUNK_CELLS * hm.cell
/** Apron cells beyond each map edge (96 m: more than the camera ever shows past the bounds). */
export const APRON = 24
const CELLS_X = hm.cols - 1, CELLS_Y = hm.rows - 1
/** South-west corner of chunk (0, 0), metres. */
const CHUNK_ORIGIN = { x: hm.x0 - APRON * hm.cell, y: hm.y0 - APRON * hm.cell } as const
/** Chunk counts along x and y, apron included. */
export const CHUNKS = {
  x: Math.ceil((CELLS_X + 2 * APRON) / CHUNK_CELLS),
  y: Math.ceil((CELLS_Y + 2 * APRON) / CHUNK_CELLS)
} as const

/** Chunk key of a map point (any static piece goes in the chunk holding its anchor). */
export const chunkOf = (x: number, y: number): number => {
  const cx = Math.min(CHUNKS.x - 1, Math.max(0, Math.floor((x - CHUNK_ORIGIN.x) / CHUNK)))
  const cy = Math.min(CHUNKS.y - 1, Math.max(0, Math.floor((y - CHUNK_ORIGIN.y) / CHUNK)))
  return cy * CHUNKS.x + cx
}

const ROCK: CoverLook = { base: PALETTE.limestone, alt: PALETTE.stoneLight, share: 0.35 }
/** Faces steeper than this (normal y below it, ≈ 50°) show bare rock. */
const ROCK_NORMAL_Y = 0.64

const PATCH = 4 // cells between noise lattice points: variant patches are blobs of ~16 m, not single cells
/** Smooth value noise in [0, 1): hashed lattice values blended bilinearly. */
const patchNoise = (i: number, j: number): number => {
  const fi = Math.floor(i / PATCH), fj = Math.floor(j / PATCH), u = i / PATCH - fi, v = j / PATCH - fj
  const a = hash01(fi, fj), b = hash01(fi + 1, fj), c = hash01(fi, fj + 1), d = hash01(fi + 1, fj + 1)
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v
}

/** Picks the base or variant colour of a look for cell (i, j). */
const shade = (look: CoverLook, i: number, j: number): number =>
  (look.stripes === true ? (i & 1) === 1 : patchNoise(i, j) < look.share) ? look.alt : look.base

/** Builds the terrain chunk `key` (see `chunkOf`) coloured by the cover raster. */
export const terrainChunk = (key: number, cover: Uint8Array): BufferGeometry => {
  const ci = key % CHUNKS.x, cj = Math.floor(key / CHUNKS.x)
  const i0 = -APRON + ci * CHUNK_CELLS, j0 = -APRON + cj * CHUNK_CELLS
  const i1 = Math.min(i0 + CHUNK_CELLS, CELLS_X + APRON), j1 = Math.min(j0 + CHUNK_CELLS, CELLS_Y + APRON)
  const cells = (i1 - i0) * (j1 - j0)
  const position = new Float32Array(cells * 18), normal = new Float32Array(cells * 18), color = new Float32Array(cells * 18)
  let v = 0
  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, rgb: readonly [number, number, number]) => {
    position[v] = x; position[v + 1] = y; position[v + 2] = z
    normal[v] = nx; normal[v + 1] = ny; normal[v + 2] = nz
    color[v] = rgb[0]; color[v + 1] = rgb[1]; color[v + 2] = rgb[2]
    v += 3
  }
  // One triangle a-b-c given in sim (x, y, h); emitted as three (x, h, -y).
  const tri = (ax: number, ay: number, ah: number, bx: number, by: number, bh: number, cx: number, cy: number, ch: number, look: CoverLook, i: number, j: number) => {
    const ux = bx - ax, uy = bh - ah, uz = ay - by, vx = cx - ax, vy = ch - ah, vz = ay - cy
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    nx /= l; ny /= l; nz /= l
    const rgb = linear(shade(ny < ROCK_NORMAL_Y ? ROCK : look, i, j))
    put(ax, ah, -ay, nx, ny, nz, rgb)
    put(bx, bh, -by, nx, ny, nz, rgb)
    put(cx, ch, -cy, nx, ny, nz, rgb)
  }
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
    const ki = Math.min(CELLS_X - 1, Math.max(0, i)), kj = Math.min(CELLS_Y - 1, Math.max(0, j))
    const look = COVER_LOOK[coverName(cover[kj * CELLS_X + ki]!)]
    const x = hm.x0 + i * hm.cell, y = hm.y0 + j * hm.cell, x1 = x + hm.cell, y1 = y + hm.cell
    const sw = terrainNodeY(i, j), se = terrainNodeY(i + 1, j), nw = terrainNodeY(i, j + 1), ne = terrainNodeY(i + 1, j + 1)
    // Split along the south-west → north-east diagonal, as `terrainY` assumes.
    tri(x, y, sw, x1, y, se, x1, y1, ne, look, i, j)
    tri(x, y, sw, x1, y1, ne, x, y1, nw, look, i, j)
  }
  const g = new BufferGeometry()
  g.setAttribute("position", new Float32BufferAttribute(position, 3))
  g.setAttribute("normal", new Float32BufferAttribute(normal, 3))
  g.setAttribute("color", new Float32BufferAttribute(color, 3))
  return g
}
