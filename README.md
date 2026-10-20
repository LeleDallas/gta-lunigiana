# GTA: Lunigiana

A small GTA-like game set in Monzone, a village in the comune of Fivizzano (Massa-Carrara, Italy).
You walk the streets, steal parked cars, carjack traffic and knock pedestrians over. The view is a
fixed isometric camera with a low-resolution pixel-art look.

The map is the real village. It is generated from OpenStreetMap and an elevation model: roads,
buildings, the Lucido and Caldanella streams, the Lucca–Aulla railway, woods and terrain are all in
their real places, about 1.9 × 1.4 km around the station and Monzone Alto.

## Requirements

- Node 24. It runs the TypeScript tests and map tools directly, with no build step.
- pnpm 10 (`packageManager` is pinned in `package.json`; `corepack enable` provides it).
- A browser with WebGL.

## Run

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173. Every load is a new world. Add `?seed=N` (for example
`http://localhost:5173/?seed=42`) to replay the same world: the seed drives every random choice,
so the same seed and the same keys give the same game.

In dev mode, the backslash key toggles the Ritmo monitor.

## Controls

| Key | On foot | Driving |
|---|---|---|
| W A S D or arrow keys | walk along the screen directions | up: throttle, down: brake and reverse, left/right: steer |
| Shift | sprint | |
| F, E or Enter | enter the nearest vehicle (steal, enter or carjack) | get out |
| Space | | handbrake |

The bindings live in `bindings` in `src/sim/schema.ts`. The HUD shows the street and district you
are in, cars stolen, people hit, the action the key would take, a speedometer while driving, and
a minimap.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Vite dev server on port 5173 |
| `pnpm build` | production build into `dist/` |
| `pnpm preview` | serves `dist/` on port 4173 |
| `pnpm check` | `typecheck`, then `lint`, then `test` |
| `pnpm typecheck` | `tsc` (no emit) |
| `pnpm lint` | `oxlint` with the Ritmo plugin, then `ritmo-devtools lint src/sim/index.ts` |
| `pnpm test` | `node --test` over `src/**/*.test.ts` |
| `pnpm map` | rebuilds `src/sim/map/monzone.json` from `data/raw` |

## Layout

| Path | Contents |
|---|---|
| `src/sim/` | the simulation: Ritmo schema, systems, collision, routes, tuning. Headless and deterministic |
| `src/sim/systems/` | one file per system group (spawn, enter/exit, foot, drive, traffic, pedestrians, physics, contacts, populate) |
| `src/sim/map/` | the generated map (`monzone.json`), its types and lookups (heights, walls, road graph) |
| `src/render/` | Three.js host code: pixel pipeline, static world meshes, actor meshes, the render schedule |
| `src/hud/` | DOM HUD: location names, score, prompt, speedometer, minimap |
| `src/tools/` | the map pipeline (`build-map.ts`) and a top-down preview renderer |
| `src/main.ts` | browser host: builds the scene, makes the runtime, runs the fixed loop |
| `index.html` | canvas, HUD markup and title card |
| `data/raw/` | pinned map inputs: OSM extract, forest relations, elevation tiles |
| `docs/` | architecture, map pipeline and gameplay notes |

## Rebuilding the map

```sh
pnpm map
```

The build reads only `data/raw` and takes about a second. Its output is deterministic: with the
same inputs, `monzone.json` comes out byte-identical. Never edit `monzone.json` by hand.

Inputs in `data/raw`:

- `monzone.osm`: an OpenStreetMap API 0.6 extract for lat 44.150–44.168, lon 10.118–10.142
  (`https://api.openstreetmap.org/api/0.6/map?bbox=10.118,44.150,10.142,44.168`).
- `rel/3009596.osm` (`landuse=forest`) and `rel/9736893.osm` (`natural=wood`): the two forest
  multipolygons, fetched whole with `https://api.openstreetmap.org/api/0.6/relation/<id>/full`.
  Most of their member ways lie outside the extract, so they cannot be assembled from it.
- `terrarium/15_<x>_<y>.png`: 16 Terrarium elevation tiles at zoom 15, x 17304–17307 and
  y 11893–11896, from `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/<x>/<y>.png`.
  Zoom 16 does not exist in that bucket.

Downloading the data again pulls current OSM edits, so the map changes. The files in `data/raw`
are what pins it. `node src/tools/preview-map.ts` draws a top-down PNG of the built map (see
[docs/map.md](docs/map.md)).

## Data attribution and licences

- Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0:
  https://www.openstreetmap.org/copyright. `monzone.json` is a derived database and stays under
  the ODbL.
- Elevation: AWS Terrain Tiles (Terrarium format, built by Mapzen's Joerd). The tiles combine
  several open sources, each with its own required attribution; for Europe that includes
  "produced using Copernicus data and information funded by the European Union - EU-DEM layers"
  and SRTM / GMTED2010 "courtesy of the U.S. Geological Survey". Full list:
  https://github.com/tilezen/joerd/blob/master/docs/attribution.md.

The game shows both credits on the title card and in the HUD.

## Documentation

- [docs/architecture.md](docs/architecture.md): simulation and host, schedules, state, input,
  rendering, HUD and checks.
- [docs/map.md](docs/map.md): the map pipeline, the JSON format and the data's limits.
- [docs/gameplay.md](docs/gameplay.md): on foot, vehicles, traffic, pedestrians, score and tuning.
