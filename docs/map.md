# The map

`pnpm map` runs `src/tools/build-map.ts`. It turns the pinned inputs in `data/raw` into
`src/sim/map/monzone.json`, the only map file the game loads. The build is deterministic and takes
about a second. It prints a lap time per stage and a summary: counts, the steepest grade per road
class, and the size of each section. Inputs and attribution are in the [README](../README.md).

`src/sim/map/kinds.ts` holds the vocabulary that the build and the game share: road classes and
their widths, building styles, area kinds, and the tree-trunk size. It imports no data, so the
build can use it before `monzone.json` exists.

## Pipeline

### 1. OSM parse (`osm.ts`, `features.ts`)

A regex reader parses the OSM API 0.6 XML into nodes, ways and relations, and assembles
multipolygon rings from member ways (unclosed chains are dropped). The two forest relations come
from their own `/full` files, because the main extract lacks most of their members.

### 2. Projection and play area (`geometry.ts`)

Equirectangular around `ORIGIN` (lat 44.16175, lon 10.13), with `M_PER_DEG` = 111115.37 m per
degree of latitude and 79987.94 m per degree of longitude. x = east, y = north, in metres, rounded
to 0.1 m. The play area `BOUNDS` is lat 44.1555–44.1680, lon 10.1180–10.1420, which is x ±959.9 m
and y ±694.5 m. Lines are clipped with Liang–Barsky and rings with Sutherland–Hodgman.

### 3. Features (`features.ts`)

- **Roads**: highway classes `tertiary`, `unclassified`, `residential`, `service`, `track`,
  `path` and `steps`. Other highway values are skipped. The width comes from the class (6.5, 5,
  4.5, 3.5, 3, 1.5 and 2 m). The ways keep `oneway`, `bridge`, `tunnel`, `layer`, `maxheight` and
  private access. Unnamed roads take a street name from `addr:street` votes (the nearest road to
  most addresses with that name). This is how Via Cesare Battisti gets its name.
- **Water**: every `waterway` except culverts. Torrente Lucido (river part) is 14 m wide, Lucido
  and Caldanella are 8 m, other named streams 4 m, unnamed ones 2 m. Each gets a bed width and a
  depth (2.5 m for rivers, 1.5 m for the two main streams, 1 m for the rest).
- **Rail**: `railway=rail` (the Lucca–Aulla line), with bridges and tunnels.
- **Buildings**: closed ways and multipolygon relations. Height is the `height` tag clamped to
  2.5–22 m, otherwise 6 m (ruins 2.5 m); the bell tower and a church on a spur have hand-set
  heights. Style, in this order: `ruin`, `church`, `tower`, `station`, `industrial`, then `stone`
  inside the three hill-village cores (Monzone Alto, Aiola, Castellaccio) and `plaster`
  elsewhere. Plaster and stone buildings within 25 m of each other take their cluster's majority
  style, so a hamlet never splits at a core radius. `tint` 0–3 comes from a hash of the id.
- **Areas**: landuse, leisure, amenity, railway platform, historic ruins, grassland and wood
  polygons, mapped to `AREA_KINDS`, plus the two forest relations.
- **Barriers**: `barrier=wall`, `barrier=guard_rail` and `natural=cliff` lines.
- **POIs**: tagged nodes (minus guideposts, level crossings, benches and most highway nodes),
  plus named polygons as centroid POIs with kind `area:<kind>`.

### 4. Heightmap (`terrain.ts`, `png.ts`)

The 16 Terrarium tiles (z15) are decoded with a small PNG decoder on `node:zlib`. Elevation is
`R × 256 + G + B / 256 − 32768` m, sampled bilinearly in local metres onto a 4 m grid over the
bounds (481 × 349 nodes) and 3 × 3 box-blurred. Within 12 m of a tile seam, a 7-tap blur across
the seam irons out the ~1 m creases the tiles have there. This blurred, uncarved grid is the
"ground" every profile below samples.

### 5. River carving (`water.ts`)

- The water surface is sampled every 2 m at ground − depth/2. It is made monotone downstream and
  continuous at confluences: a tributary's tail is lowered (by at most 0.25 extra slope) or ponded
  up to the level of the water it joins.
- The bed is carved into the grid: depth/2 below the surface inside w/2, a gravel slope out to the
  bed width, then a one-cell bank back to the terrain.

### 6. Road and rail profiles (`profiles.ts`, `terrain.ts`)

- Pieces are chained through nodes where exactly two ends meet. Each chain is resampled every 4 m
  from the ground and smoothed with a moving average. Bridges and tunnels are straight between
  their ends.
- The profile is then fitted to a grade limit through hard pins: elevations already set at
  shared nodes by earlier chains, and rail clearance bounds. The fit is the midpoint of the two
  grade envelopes, so cut and fill split evenly.
- Where the fit strays more than 4 m from the smoothed ground, the grade limit within 60 m is
  raised in 10% steps, up to 1.5× the class limit.

| Pass (in order) | Grade limit | Smoothing half-window | Rank |
|---|---|---|---|
| rail | 2.5% | 100 m | 1 |
| tertiary | 10% | 35 m | 0 |
| unclassified, residential | 15% | 35 m | 2 |
| service, track | 20% | 35 m | 3 |

- Each profile is written into the grid: the core (max(w/2 + 0.5, 3) m) takes the road
  elevation, and the next 8 m blend back to the terrain. At junctions the lower rank keeps the
  cell, so tertiary beats rail and rail beats the rest.
- Grid nodes inside the wider streams (w ≥ 4 m) are protected: no road writes them. Bridges and
  tunnels write nothing. Paths and steps are not profiled.
- Rail: level crossings meet the road at its natural level. A road under the rail keeps
  `maxheight` (4 m when untagged) plus a 1.5 m deck below it. The rail stays at least 3 m above
  the water it bridges.

### 7. Water under decks (`water.ts`)

Bridges keep 2.5 m of clearance over the water: the surface is capped there, settled again
downstream, and re-carved outside road cores. At-grade road crossings imply a culvert, where the
water dips 0.3 m below the road. Water left perched more than 1 m above the terrain (streams that
end at a road cut) drops to the terrain, except inside a wider channel it flows into. The grid is
then rounded to 0.1 m and stored as integer decimetres.

### 8. Collision walls (`walls.ts`)

Walls are segments of at most 16 m. Blocked 4 m cells are traced with marching squares and
simplified (Douglas–Peucker, 1.5 m tolerance). Slopes use a 12 m baseline, because the DEM
resolves about 30 m. Steep cells are majority-filtered (3 × 3) so the walls follow real slopes,
not DEM noise.

| Wall source | `walk` | `drive` |
|---|---|---|
| Water cells (within max(w/2, 2) m of the centreline) | yes, except on any road | yes, except where a drivable road crosses (bridge or ford) |
| Slope | > 35°, except on any road | > 25°, except within w/2 + 1.5 m of a drivable road |
| Building outlines | yes | yes |
| `wall`, `cliff` barriers | yes | yes |
| `guard_rail` barriers | no | yes |
| Map bounds | yes | yes |
| Road-exit caps (4 m inside, where drivable roads leave the area) | no | yes |

- Road buffers are padded by half a cell plus the simplification tolerance, so no traced wall
  comes within w/2 of a centreline. The carved banks of the wider streams skip the slope test.
- Where a road centreline runs through a footprint (lanes under arches, steps), the building wall
  is the footprint minus a corridor of min(w/2, 1.2) m half-width, rasterised at 0.2 m. The lane
  stays open and the interior stays closed.
- Tree trunks are not stored as walls. At load, `wallsNear` adds a 0.5 m square around each tree.

### 9. Road graph (`graph.ts`)

Nodes come from shared OSM node ids (clip points get their own), and edges are split to at most
25 m. Where a road leaves the play area, its end is pulled back 8 m, past the exit cap. `traffic`
is the largest connected component of `tertiary`, `unclassified`, `residential` and `service`
edges, minus private roads and dead-end tunnel spurs; tracks are drivable by the player but get no
AI traffic. `walk` is the largest connected component of every edge except tunnels.

### 10. Trees, spawns, districts (`spawns.ts`, `build-map.ts`)

- **Trees**: a jittered lattice at one tree per 50 m² inside forest areas. Trees stay out of other
  areas, buildings (plus 2 m), roads (w/2 + 2 m), stream beds and the rail (6 m). Sparse trees
  also line the banks of the wider streams. Capped at 40000, with positions rounded to 1 m and a
  scale of 0.8–1.3. Placement uses a fixed hash, not a random generator.
- **Player spawn**: the Via Cesare Battisti sidewalk nearest the Carabinieri station, with 1.3 m
  clear of walk and drive walls.
- **Parked spots**: up to 100 on the right kerb of tertiary, unclassified and residential roads
  (not bridges or tunnels), at least 12 m from junctions and 9 m from each other, with two or more
  buildings within 40 m, off every carriageway and clear of walls. Car parks within 150 m of the
  station add up to 6 nose-in spots each.
- **Districts**: 14 hand-placed discs (name, centre, radius) in `build-map.ts`. `districtAt`
  picks the disc the point is relatively closest to, or the nearest rim outside every disc.

## JSON format

`MonzoneMap` in `src/sim/map/index.ts` is the schema. Polylines and rings are flat
`[x0, y0, x1, y1, ...]` arrays. Rings are open: outer rings counter-clockwise, holes clockwise.

| Field | Contents |
|---|---|
| `version` | `1` |
| `origin`, `mPerDeg` | projection origin (lat, lon) and metres per degree |
| `bounds` | play area `minX`, `minY`, `maxX`, `maxY` (m) |
| `heightmap` | `cell` (4 m), `cols`, `rows`, `x0`, `y0`, `data`: integer decimetres, row-major, row 0 = south |
| `roads` | `id`, `cls`, `name?`, `ref?`, `w`, `surface`, `oneway?`, `bridge?`, `tunnel?`, `layer?`, `pts`, `z` (surface elevation per vertex) |
| `buildings` | `id`, `kind`, `name?`, `h` (wall height), `z0` (lowest ground under the footprint), `style`, `ruins?`, `tint`, `outer`, `holes?` |
| `water` | `id`, `kind` (`river` or `stream`), `name?`, `w`, `pts`, `z` (water surface per vertex) |
| `rail` | `id`, `bridge?`, `tunnel?`, `pts`, `z` (rail top per vertex) |
| `areas` | `kind` (one of `AREA_KINDS`), `name?`, `rings` (outer first, then holes) |
| `barriers` | `kind` (`wall`, `guard_rail`, `cliff`), `pts` |
| `pois` | `id`, `kind` (`key=value` or `area:<kind>`), `name?`, `x`, `y` |
| `districts` | `name`, `x`, `y`, `r` |
| `graph` | `xy` (node coordinates), `edges` (flat `a, b, roadIndex` triples), `traffic`, `walk` (edge indices) |
| `walls` | `walk`, `drive`: flat `ax, ay, bx, by` segments |
| `trees` | flat `x, y, scale` triples |
| `spawns` | `player` and `parked`: `{ x, y, angle }` |

Profiled roads and rail carry extra points where the elevation bends between OSM vertices (dips
under the rail, crests). Graph edges run a → b in the OSM way direction, so a `oneway` road may
only be driven from a to b. Game code reads the map through `src/sim/map/index.ts`: `MAP`,
`graph`, `heightAt`, `wallsNear`, `districtAt`, `roadClassOf` and `buildingStyleOf`. It never
reads the raw JSON.

## Checks and tools

`src/sim/map/map.test.ts` checks the built map: heightmap coverage, spawns clear of walls and
off traffic lanes, no walls on roads, closed building interiors, one traffic component reaching
the station and Monzone Alto, grades within 1.5× the class limits, bridge and underpass
clearances, no perched water, and valid names, classes, styles, area kinds and districts. Run
`pnpm test` after every `pnpm map`.

`node src/tools/preview-map.ts [pxPerM=1] [minX,minY,maxX,maxY] [out.png]` draws a top-down PNG of
the built map. It writes `.research/map-preview.png` by default.

## Known data limitations

- **Elevation is coarse.** The Terrarium data resolves about 30 m (consistent with a 1″ source
  such as SRTM or EU-DEM), and zoom 15 is the highest level available. The 4 m grid oversamples
  it, the blur hides the facets, and slopes come from a 12 m baseline. Cliffs and terraces
  smaller than that are missing.
- **Roads and rivers are not in the DEM.** Along SP10 the raw DEM gives local grades of 17–33%
  where the road really climbs about 5% (cross-slope noise from a hillside cut narrower than the
  DEM resolution), and the river's raw profile goes up and down. Profiles and carving synthesise
  both. Where the terrain forces it, a road's grade is relaxed up to 1.5× its class limit.
- **Paths and steps follow the raw terrain.** They can be very steep (the summary prints the
  worst grade per class).
- **Building data is sparse.** Most buildings have no `height` tag (default 6 m) and none have
  roof tags, so roofs are procedural (`src/render/roof.ts`: hip roof when the footprint nearly
  fills its minimum-area rectangle, flat otherwise).
- **Some names only exist on addresses** (Via Cesare Battisti). The vote can pick the wrong piece
  of road. Culverted waterways are dropped; at-grade crossings imply a culvert instead.
- **The extract ends at 44.168 N and 10.118 E.** The hamlets just beyond (Monte dei Bianchi,
  Mezzana, Isolano) are not in the map. Re-downloading pulls newer OSM edits and changes the map;
  `data/raw` is the source of truth.
