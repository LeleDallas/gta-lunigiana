import assert from "node:assert/strict"
import { test } from "node:test"

import { AREA_KINDS } from "../sim/map/index.ts"
import { coverName, rasterCover } from "./landcover.ts"

// 10 × 10 cells of 4 m from (0, 0); row 0 = south.
const heightmap = { cell: 4, cols: 11, rows: 11, x0: 0, y0: 0, data: Array.from({ length: 121 }, () => 2000) }
const at = (raster: Uint8Array, x: number, y: number) => coverName(raster[Math.floor(y / 4) * 10 + Math.floor(x / 4)]!)

test("areas fill even-odd (holes stay meadow) and later kinds draw over forest", () => {
  const raster = rasterCover({
    heightmap,
    water: [],
    areas: [
      { kind: "parking", rings: [[20, 20, 28, 20, 28, 28, 20, 28]] },
      { kind: "forest", rings: [[0, 0, 40, 0, 40, 40, 0, 40], [4, 4, 4, 12, 12, 12, 12, 4]] }
    ]
  })
  assert.equal(at(raster, 2, 2), "forest")
  assert.equal(at(raster, 6, 6), "meadow")
  assert.equal(at(raster, 22, 22), "parking")
})

test("wide water gets a pebble bed, narrow streams none", () => {
  const raster = rasterCover({
    heightmap,
    areas: [],
    water: [
      { id: 1, kind: "river", w: 14, pts: [0, 30, 40, 30], z: [200, 200] },
      { id: 2, kind: "stream", w: 2, pts: [0, 6, 40, 6], z: [200, 200] }
    ]
  })
  assert.equal(at(raster, 10, 30), "pebble")
  assert.equal(at(raster, 10, 37), "pebble") // cell centre 8 m out: past the water (7 m), inside the bed (12 m)
  assert.equal(at(raster, 10, 6), "meadow")
})

test("every area kind paints as its own cover", () => {
  for (const kind of AREA_KINDS) assert.equal(at(rasterCover({ heightmap, water: [], areas: [{ kind, rings: [[0, 0, 8, 0, 8, 8, 0, 8]] }] }), 2, 2), kind)
})
