# GTA: Lunigiana

A small GTA-like game set in Monzone, a village in the comune of Fivizzano (Massa-Carrara, Italy).
You walk the streets, steal parked cars, carjack traffic and knock pedestrians over. The view is a
fixed isometric camera with a low-resolution pixel-art look.

The map is the real valley, about 5.2 × 4.6 km: Monzone and Aiola, the Lucido down to Gragnola on
the Aulella, Equi Terme, Codiponte and Casciana, and the hill villages west of the Lucido (Viano,
Pieve di Viano, Colognola, Campiglione, Vezzanello). Roads (with the SR445 della Garfagnana), the
Aulella, Lucido and Caldanella, the Lucca–Aulla railway, woods and place names come from
OpenStreetMap. Buildings (with their surveyed eave heights), road widths and surfaces come from
Regione Toscana's 1:2000 technical map (2019), and the terrain from its 1 m LiDAR survey (2010).

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
| `pnpm fetch-osm` | downloads the OpenStreetMap extract again into `data/raw/lunigiana.osm.gz` |
| `pnpm fetch-rt` | downloads the Regione Toscana sources again into `data/raw/rt` |

## Layout

| Path | Contents |
|---|---|
| `src/sim/` | the simulation: Ritmo schema, systems, collision, routes, tuning. Headless and deterministic |
| `src/sim/systems/` | one file per system group (spawn, enter/exit, foot, drive, traffic, pedestrians, physics, contacts, populate) |
| `src/sim/map/` | the generated map (`monzone.json`), its types and lookups (heights, walls, road graph) |
| `src/render/` | Three.js host code: pixel pipeline, static world meshes, actor meshes, the render schedule |
| `src/hud/` | DOM HUD: location names, score, prompt, speedometer, minimap |
| `src/tools/` | the map pipeline (`build-map.ts`), the downloaders (`fetch-osm.ts`, `fetch-rt.ts`) and a top-down preview renderer |
| `src/main.ts` | browser host: builds the scene, makes the runtime, runs the fixed loop |
| `index.html` | canvas, HUD markup and title card |
| `data/raw/` | pinned map inputs: OSM extract, Regione Toscana CTR and LiDAR |
| `docs/` | architecture, map pipeline and gameplay notes |

## Rebuilding the map

```sh
pnpm map
```

The build reads only `data/raw` and takes about 3.5 s. Its output is deterministic: with the
same inputs, `monzone.json` (about 10.6 MB) comes out byte-identical. Never edit `monzone.json`
by hand.

Inputs in `data/raw`:

- `lunigiana.osm.gz`: an OpenStreetMap API 0.6 extract of the play area plus 100 m (lat
  44.1546–44.1977, lon 10.0925–10.1600), written by `pnpm fetch-osm` (`src/tools/fetch-osm.ts`)
  from 4 × 4 `https://api.openstreetmap.org/api/0.6/map?bbox=...` tiles. Every land-use, natural,
  building, leisure or amenity multipolygon is fetched whole with
  `https://api.openstreetmap.org/api/0.6/relation/<id>/full`, because most of a forest's member
  ways lie outside the play area. Elements are merged by id and sorted, so the same OSM data
  always gives the same file.
- `rt/`: Regione Toscana data from the Geoscopio cartoteca, written by `pnpm fetch-rt`
  (`src/tools/fetch-rt.ts`, which needs `unzip`; the download URLs are pinned there):
  - `ctr/<sheet>_<layer>.shp.gz` + `.dbf.gz`: CTR 1:2000 (2019), the 16 sheets over the play
    area (23D11–13, 23D18–21, 23D26–29, 23D34–37, 23D43), layers `AED` (buildings with eave
    elevations), `AGE` (garages, ruins), `AVI` (road surfaces with street names) and `AZR` (the
    area each sheet maps).
  - `dtm.bin` + `dtm.json`: the 1 m LiDAR terrain model (2010) of the 20 tiles over the play
    area, mosaicked, cropped to the play area plus 32 m and averaged to 2 m cells.

Downloading the OSM data again pulls current edits, so the map changes. The files in `data/raw`
are what pins it. `node src/tools/preview-map.ts` draws a top-down PNG of the built map (see
[docs/map.md](docs/map.md)).

## Data attribution and licences

- Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0:
  https://www.openstreetmap.org/copyright. `monzone.json` is a derived database and stays under
  the ODbL.
- Buildings, road surfaces and elevation: "Fonte dei dati: Regione Toscana – Rilievi LIDAR" and
  the Carta Tecnica Regionale 1:2000, both under Creative Commons Attribution 4.0
  (https://creativecommons.org/licenses/by/4.0/), from the Geoscopio cartoteca:
  https://www502.regione.toscana.it/geoscopio/cartoteca.html.

The game shows both credits on the title card and in the HUD.

## Documentation

- [docs/architecture.md](docs/architecture.md): simulation and host, schedules, state, input,
  rendering, HUD and checks.
- [docs/map.md](docs/map.md): the map pipeline, the JSON format and the data's limits.
- [docs/gameplay.md](docs/gameplay.md): on foot, vehicles, traffic, pedestrians, score and tuning.
