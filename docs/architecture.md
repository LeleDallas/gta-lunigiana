# Architecture

The game is a Ritmo ECS simulation plus a browser host. The simulation (`src/sim`) owns every rule
that changes the world. It is headless and deterministic: no DOM, no Three.js, no wall clock, no
`Math.random`. The host (`src/main.ts`, `src/render`, `src/hud`) captures input, draws, and shows
the HUD. It reads the world and never writes saved state.

```
keyboard ──► KeyboardInput service ──► CaptureInput ──► Input resource ──► systems
                                                                             │
             HUD ◄── PlayerView (inspector) ◄────────── world (components, resources)
             three.js nodes ◄── render schedule (RenderSync) ◄──┘
```

## Simulation

`src/sim/index.ts` is the entry. It re-exports the schema, defines the schedules, and exports
`makeRuntime({ seed, services, debug? })`, which makes a runtime with the starting resources:
`Time` (60 Hz clock), `Rng` (seeded from `seed`), `Score` (zeroed) and `Input` (idle keys).

### Schedules and system order

`setup` runs once after the runtime is made:

1. `SpawnWorld` (`systems/spawn.ts`): the player, the two Carabinieri cars, 45 parked cars.
2. `applyDeferred`

`update` is one fixed step (`STEP = Clock.hz(60)`):

| # | System | File | Does |
|---|---|---|---|
| 1 | `AdvanceTime` | `index.ts` | advances `Time` (Ritmo `Clock.system`) |
| 2 | `CaptureInput` | `index.ts` | copies the `KeyboardInput` snapshot into `Input` |
| 3 | `StorePrevious` | `index.ts` | copies every `Pose` into `PrevPose` (for interpolation) |
| 4 | `EnterExit` | `systems/enter-exit.ts` | action key: enter, steal, carjack, get out |
| 5 | `applyDeferred` | | applies the enter/exit commands before anything moves |
| 6 | `PlayerFoot` | `systems/foot.ts` | player walking, sprinting, sliding when down |
| 7 | `PlayerDrive` | `systems/drive.ts` | player keys into the driven car's `CarInput` |
| 8 | `TrafficAI` | `systems/traffic.ts` | AI drivers write their `CarInput` |
| 9 | `Pedestrians` | `systems/pedestrians.ts` | walkers follow their routes, flee, slide |
| 10 | `VehiclePhysics` | `systems/physics.ts` | every vehicle moves from its `CarInput` |
| 11 | `Contacts` | `systems/contacts.ts` | car–car, car–person and person–person contacts, knockdowns |
| 12 | `RideAlong` | `systems/drive.ts` | the driving player takes the car's pose and motion |
| 13 | `Recover` | `systems/contacts.ts` | knocked-down people get up; pedestrians then flee |
| 14 | `Populate` | `systems/populate.ts` | every 0.5 s spawns and despawns traffic and pedestrians |
| 15 | `applyDeferred` | | applies spawns, despawns, inserts and removals |

Controls are read before movement, all movement happens before contacts, and contacts happen
before the player's pose follows the car. Gameplay is in [gameplay.md](gameplay.md).

### Where state lives

Saved world state (in snapshots), declared in `src/sim/schema.ts`:

| Component | On | Holds |
|---|---|---|
| `Pose`, `PrevPose` | every body | x, y (m, east/north from the map origin), angle (rad CCW from east) |
| `Motion` | every body | velocity vx, vy (m/s) and spin (rad/s) |
| `Player` | the player | tag |
| `Person` | player, pedestrians | look: skin, hair, shirt, trousers colours (immutable) |
| `Pedestrian` | pedestrians | mood (`walk` or `flee`), flee end step, steps blocked |
| `Down` | knocked-down people | step at which they get up |
| `Vehicle` | vehicles | model and paint colour (immutable) |
| `CarInput` | vehicles | throttle, steer, handbrake for this step |
| `Traffic` | AI vehicles | tag |
| `Route` | traffic, pedestrians | current graph edge, direction, lateral offset |
| `Autopilot` | traffic | next edge, stuck counter, reverse end step, unstick tries |
| `Stolen` | vehicles | tag: already entered once by the player |
| `Driving` | the player | handle of the vehicle being driven |

`Schema.requires` enforces the bundles: a `Player` has a pose, previous pose, motion and look; a
`Vehicle` has a pose, previous pose, motion and `CarInput`; `Traffic` also needs `Route` and
`Autopilot`.

Resources: `Time`, `Rng` and `Score` (`stolen`, `knocked`) are saved. `Input` is transient: it is
rebuilt every step and never saved.

Static data is module content, not state. `MAP` and `graph` (`src/sim/map/index.ts`), the wall
indexes, and the per-model lane tables in `src/sim/route.ts` are built once at load and never
change, so they are safe to share between runtimes.

Host state stays in the host: the camera, the render clock, the three.js scene and nodes, and the
HUD's DOM.

## Input

1. `src/main.ts` makes `Keyboard.actions(window, bindings)` and passes it as the `KeyboardInput`
   service.
2. `CaptureInput` (Ritmo's `InputCapture.system`) copies its snapshot into the `Input` resource
   at the start of each step.
3. Systems read `Input`: `held` for movement, steering and handbrake, `pressed` (once per press)
   for the action key.

`bindings` in `src/sim/schema.ts` is the only list of keys. Tests and replays use the same path:
`Keyboard.scripted(bindings, timeline)` replaces the live keyboard.

## Host loop

`src/main.ts` drives everything from one `FixedLoop`: 60 Hz steps, at most 5 steps per frame, and
frames clamped to 0.25 s. Each animation frame it:

1. writes the loop's `alpha` (fraction of a step since the last one) into `RenderClock`;
2. ticks the `render` schedule;
3. reads `PlayerView` and moves the camera;
4. renders the pixel view, then updates the HUD.

The seed comes from `?seed=N`, or a random 32-bit number.

## Rendering

The render schedule (`src/render/index.ts`) uses `@typeonce/ritmo-render`:

- `SyncPeople` and `SyncVehicles` (`RenderSync.system`) keep one three.js node per entity with a
  `Person` or a `Vehicle`, in the `People` and `Vehicles` node registries. A person in a car is
  hidden; a knocked-down person lies flat.
- `MarkDriven` shows the x-ray silhouette (drawn only where the world hides the actor) on the
  player's car and no other vehicle. `SyncPeople` shows it on the player's figure.
- `PlacePeople` and `PlaceVehicles` (`RenderSync.interpolate`) blend `PrevPose` → `Pose` at the
  render alpha and stand nodes on the ground or road under them (`groundY` in
  `src/render/ground.ts`). Vehicles pitch to the slope; people swap between three walk frames.

The static world (`src/render/world.ts`) is built once from `MAP`. Each 128 m chunk gets a terrain
mesh, a solid mesh (buildings, roofs, bridges, platforms) and a decal mesh (roads, water, rail).
Trees are instanced. A 96 m apron continues the terrain beyond the map bounds.

The pixel pipeline (`src/render/pipeline.ts`):

- An orthographic camera at 30° elevation. At that angle the ground axes project to exact 2:1
  pixel lines.
- The camera sits north-west of the focus and looks south-east. `SCREEN_UP` and `SCREEN_RIGHT`
  in `src/sim/view.ts` define this. The sim maps on-foot keys through them, and the camera,
  minimap and sun are built from them. The mountains rise to the south and east, so this side
  sees every street.
- The scene renders into a low-resolution HalfFloat target about 270 texels tall. One fullscreen
  pass then darkens depth edges (outlines), converts to sRGB, and upscales by an integer factor.
- The camera snaps to the texel grid and the remainder becomes a sub-texel scroll offset. The
  static world never shimmers, but the view still scrolls smoothly.
- Zoom (`zoomFor`): 8 texels/m on foot, 6 in a car, 5 above 16 m/s (back to 6 below 13 m/s).
- The camera leads the player by 0.6 s of velocity, at most 14 m (`LOOK_AHEAD`), and eases
  toward its target.
- The sun's shadow box follows the view, snapped to shadow-map texels.

## HUD

The HUD (`src/hud`) is plain DOM over the canvas, with its markup in `index.html`. It reads only
the `PlayerView` inspector (`src/sim/views.ts`) and the map:

- `PlayerView` returns a `PlayerViewModel`: previous and current pose, velocity, mode (`foot`,
  `driving`, `down`), the driven vehicle's label and speed, the vehicle in reach (label,
  occupied, stolen), and the score.
- `vehicleInReach` (`src/sim/body.ts`) answers both the HUD prompt and the `EnterExit` action, so
  the prompt never offers something the key will not do.
- Location: the nearest named road within 15 m (tracks and paths skipped) and the district disc
  from `districtAt`. Looked up again only after moving 2 m.
- The minimap is drawn once to an offscreen canvas and then blitted around the player, 300 m
  across, rotated so that screen-up is up.

## Checks

`pnpm check` runs:

- `tsc`: strict TypeScript, no emit.
- `oxlint` (`.oxlintrc.json`) with `@typeonce/oxlint-plugin-ritmo`:
  - everywhere: `handle-tick-result`, `prefix-descriptor-and-system-names`, `use-cell-value`;
  - in `src/sim/**`: `use-clock-for-time`, `use-random-for-randomness`, `use-ops-for-math`,
    `keep-simulation-headless`, `no-infinity-in-simulation-data`, and a ban on importing
    `render`, `hud` or `main.ts`.
- `ritmo-devtools lint src/sim/index.ts`: loads `lintTarget` and lints the `setup`, `update` and
  (described, not run) `render` schedules. Any warning fails. It also fails if a module the sim
  loads is not covered by the oxlint simulation override.
- `node --test`. Beside the unit tests, these guard the architecture:
  - `determinism` (`src/sim/index.test.ts`): `Determinism.check` runs a 600-frame scripted joyride
    twice and requires identical state, transient components included.
  - `saves`: a snapshot taken mid-joyride goes through JSON, restores into a fresh runtime, and
    plays on identically.
  - `src/render/index.test.ts`: every render-schedule system declares no writes.
  - `src/sim/map/map.test.ts`: invariants of the generated map (see [map.md](map.md)).

`src/sim/testing.ts` is the headless test kit: `start(timeline, staging)` makes a runtime with
scripted keys, `stage` clears the map and places exactly the cars and pedestrians a test needs,
and `World` inspects everything as plain data.
