// Downloads the Regione Toscana sources (CC BY 4.0, Geoscopio cartoteca) and writes the pinned
// subsets the map build reads to data/raw/rt. Run: node src/tools/fetch-rt.ts  (pnpm fetch-rt).
// Needs `unzip` on the PATH. The archives are cached in the OS temp directory.
// - ctr/<sheet>_<layer>.shp.gz + .dbf.gz: CTR 1:2000, 2019 flight, EPSG:6707. AED = buildings,
//   AGE = other areas (garages, ruins), AVI = road areas, AZR = the mapped area of each sheet.
//   Some sheets map only part of their frame; where none does, OSM fills in.
// - dtm.json + dtm.bin: LiDAR DTM, 2010 flight, EPSG:3003. The 1 m tiles mosaicked, cropped to
//   the play area plus MARGIN and averaged to 2 m cells (the game grid is 4 m); int16 decimetres,
//   each row delta-coded, deflated.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { deflateSync, gzipSync } from "node:zlib"

import { latLonToGaussBoaga } from "./crs.ts"
import { BOUNDS, fromLocal } from "./geometry.ts"

const ROOT = join(import.meta.dirname, "../..")
const OUT = join(ROOT, "data/raw/rt")
const CACHE = join(tmpdir(), "gta-lunigiana-rt")
const BASE = "https://www502.regione.toscana.it/geoscopio/download"

/** Every 2019 CTR 1:2000 sheet over the play area (cartoteca layer rt_cartoteca.ctr2k). */
const CTR_SHEETS = ["23D11", "23D12", "23D13", "23D18", "23D19", "23D20", "23D21", "23D26", "23D27", "23D28", "23D29", "23D34", "23D35", "23D36", "23D37", "23D43"] as const
const CTR_LAYERS = ["AED", "AGE", "AVI", "AZR"] as const
/** Every 2010 LiDAR DTM tile over the play area (cartoteca layer rt_cartoteca.lidar2k; the suffix is the archive's hash). */
const DTM_TILES = [
  "23d10_1x1_dtm_004_2010_3003_f7ad492db7c7b72600ec64388e12df88", "23d11_1x1_dtm_004_2010_3003_6608383f82231dd57fa923769433d385",
  "23d12_1x1_dtm_004_2010_3003_2826377b2b700ff0a7060d9bed617ab7", "23d13_1x1_dtm_004_2010_3003_1058df2745552875df0878b3da36071c",
  "23d18_1x1_dtm_004_2010_3003_5932526d02e4a47fa030ccc26ccf1d0f", "23d19_1x1_dtm_004_2010_3003_79631f7e59953c2b5f52498e38497bd2",
  "23d20_1x1_dtm_004_2010_3003_f42c50305640d0ef1c3ba3bd6e234344", "23d21_1x1_dtm_004_2010_3003_7544001883ae9050bb6ec48414cfd722",
  "23d26_1x1_dtm_004_2010_3003_2f6fe17319bfc91ec4a10bc1f851414d", "23d27_1x1_dtm_004_2010_3003_45bf50a7a74bd231018f1061ea2b1f1e",
  "23d28_1x1_dtm_004_2010_3003_2253b9e5f1401b55954ffc8358cd4273", "23d29_1x1_dtm_004_2010_3003_7abfda497246d368fdc40e821e0b76a5",
  "23d34_1x1_dtm_004_2010_3003_ab6644e6be652e3a86228d8e5f63d1df", "23d35_1x1_dtm_004_2010_3003_185c6a113a23995baa9392b253fefb85",
  "23d36_1x1_dtm_004_2010_3003_2a95a140e5e8f6c1c4c10b643b8a5ba6", "23d37_1x1_dtm_004_2010_3003_af2fa3f16045fe73a80c650d4fcb42f5",
  "23d42_1x1_dtm_004_2010_3003_11c886a6545962071525e1664cf7dd03", "23d43_1x1_dtm_004_2010_3003_c201b52aea6bb63900171237c8f8a401",
  "23d44_1x1_dtm_004_2010_3003_2452372f4f645bb96b6ac6ecf3f7128f", "23d45_1x1_dtm_004_2010_3003_e4ffc1589869e3f59ad176e0646037c5"
] as const
/** DTM kept beyond the play area, m: room for the terrain grid's box filter and the projection's rotation. */
const MARGIN = 32

const fetchZip = async (url: string): Promise<string> => {
  const zip = join(CACHE, basename(url)), dir = zip.replace(/\.zip$/, "")
  if (!existsSync(dir)) {
    if (!existsSync(zip)) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
    }
    execFileSync("unzip", ["-o", "-q", zip, "-d", dir])
  }
  return dir
}

const findFile = (dir: string, name: string): string => {
  const hit = execFileSync("find", [dir, "-name", name], { encoding: "utf8" }).trim().split("\n")[0]
  if (!hit) throw new Error(`${name} missing under ${dir}`)
  return hit
}

mkdirSync(CACHE, { recursive: true })
mkdirSync(join(OUT, "ctr"), { recursive: true })

for (const sheet of CTR_SHEETS) {
  const dir = await fetchZip(`${BASE}/ctr2k/SHP/S_${sheet}_2019_6707.zip`)
  for (const layer of CTR_LAYERS) for (const ext of ["shp", "dbf"])
    writeFileSync(join(OUT, "ctr", `${sheet}_${layer}.${ext}.gz`), gzipSync(readFileSync(findFile(dir, `S_${sheet}_2019_${layer}.${ext}`)), { level: 9 }))
}

// The crop: play-area corners in Gauss-Boaga, widened by MARGIN, on the tiles' cell centres (x.5).
const corners = [[BOUNDS.minX, BOUNDS.minY], [BOUNDS.maxX, BOUNDS.minY], [BOUNDS.minX, BOUNDS.maxY], [BOUNDS.maxX, BOUNDS.maxY]]
  .map(([x, y]) => latLonToGaussBoaga(...fromLocal(x!, y!)))
const e0 = Math.floor(Math.min(...corners.map((c) => c[0])) - MARGIN) + 0.5, n0 = Math.floor(Math.min(...corners.map((c) => c[1])) - MARGIN) + 0.5
const cols = Math.ceil(Math.max(...corners.map((c) => c[0])) + MARGIN - e0) + 1, rows = Math.ceil(Math.max(...corners.map((c) => c[1])) + MARGIN - n0) + 1
const NODATA = -32768
const dm = new Int16Array(cols * rows).fill(NODATA) // row 0 = south
for (const tile of DTM_TILES) {
  const lines = readFileSync(findFile(await fetchZip(`${BASE}/altimetria/lidar/dtm/${tile}.zip`), "*.asc"), "latin1").split("\n")
  const head: Record<string, number> = {}
  for (const line of lines.slice(0, 6)) {
    const [k, v] = line.trim().split(/\s+/)
    head[k!.toLowerCase()] = Number(v)
  }
  const { ncols, nrows, xllcenter, yllcenter, cellsize, nodata_value } = head as Record<string, number>
  if (cellsize !== 1) throw new Error(`${tile}: cell size ${cellsize}`)
  for (let r = 0; r < nrows!; r++) {
    const row = Math.round(yllcenter! + (nrows! - 1 - r) - n0)
    if (row < 0 || row >= rows) continue
    const values = lines[6 + r]!.trim().split(/\s+/)
    for (let c = 0; c < ncols!; c++) {
      const col = Math.round(xllcenter! + c - e0), z = Number(values[c])
      if (col >= 0 && col < cols && z !== nodata_value && dm[row * cols + col] === NODATA) dm[row * cols + col] = Math.round(z * 10)
    }
  }
}
const holes = dm.reduce((n, v) => n + (v === NODATA ? 1 : 0), 0)
if (holes > 0) throw new Error(`${holes} DTM cells without data inside the crop`)
// 2 × 2 means: cell (i, j) covers 1 m cells 2i..2i+1, 2j..2j+1, so its centre is 0.5 m past theirs.
const cols2 = Math.floor(cols / 2), rows2 = Math.floor(rows / 2)
const deltas = new Int16Array(cols2 * rows2)
for (let j = 0, prev = 0; j < rows2; j++) for (let i = 0; i < cols2; i++) {
  const k = 2 * j * cols + 2 * i
  const mean = Math.round((dm[k]! + dm[k + 1]! + dm[k + cols]! + dm[k + cols + 1]!) / 4)
  deltas[j * cols2 + i] = i === 0 ? mean : mean - prev
  prev = mean
}
const bin = deflateSync(Buffer.from(deltas.buffer), { level: 9 })
writeFileSync(join(OUT, "dtm.bin"), bin)
const meta = { crs: "EPSG:3003", e0: e0 + 0.5, n0: n0 + 0.5, cols: cols2, rows: rows2, cell: 2, unit: "dm", encoding: "int16le, row 0 = south, each row delta-coded from its first value, deflate" }
writeFileSync(join(OUT, "dtm.json"), `${JSON.stringify(meta, null, 2)}\n`)
console.log({ ...meta, bytes: bin.length })
