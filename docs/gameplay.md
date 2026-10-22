# Gameplay

All rules are simulation systems in `src/sim/systems`. The step order is in
[architecture.md](architecture.md). Units are metres, seconds and radians. One step is 1/60 s.

## Start

`SpawnWorld` puts the player on the Via Cesare Battisti sidewalk in front of the Carabinieri
station in Lunigiana, or beside a central connected street in Cesena. The map build rejects
positions inside buildings and requires an open walking route to the street, so the player can
leave the starting spot. 200 of the map's parked spots (`PARKED`) get a car, picked at random,
so the cars spread
over the villages as the spots do. The two spots nearest the station get Carabinieri cars. The rest
are randomly chosen spots, about 80% Pandas and 20% Apes. On a tertiary-road spot where it fits,
a roll under 10% makes a marble truck instead, at most two of them. The world's `Rng` makes every
choice, so `?seed=N` replays the same start.

## The view

`TurnView` (`src/sim/index.ts`) turns the camera a quarter left (Q, counter-clockwise seen from
above) or right (E), once per press, on foot or driving. The `View` resource counts the net
quarter turns. It is saved state, because the on-foot keys follow it. In the home view (0), the
camera sits north-west of the player and looks south-east: the mountains rise to the south and
east, so this side sees every street. Driving keys steer the car and do not depend on the view.

The host swings the camera through each turn in about a third of a second, or turns it at once
under `prefers-reduced-motion`. The sun and the minimap turn with it, so the lit and shaded walls
and the minimap's top always match the screen.

## On foot

`PlayerFoot` (`systems/foot.ts`):

- The movement keys walk along the screen axes of the turned view (`screenAxes` in
  `src/sim/view.ts`). In the home view, up walks south-east on the ground and right south-west;
  each quarter turn of the view swings both a quarter. The body turns to face the keys.
- Walking speed is 2.2 m/s, sprinting (Shift) 5.5 m/s, with an acceleration of 30 m/s².
- The body is a circle of radius 0.35 m. It slides along walk walls and never passes through them
  (`walkBy` in `src/sim/body.ts`). Velocity is what actually happened, so a wall stops it.
- Knocked down, the player cannot steer and slides to a stop (10 m/s²).

## Entering, stealing, carjacking, exiting

`EnterExit` (`systems/enter-exit.ts`) handles the action key (F or Enter), once per press:

- **Enter**: on foot and standing, the player enters the vehicle whose body is nearest, within
  2 m (`ENTER_GAP`), with no walk wall in between. The HUD prompt uses the same test
  (`vehicleInReach`), so it shows exactly what the key would do: `steal`, `enter` or `carjack`.
- **Steal**: the first entry of any vehicle scores one theft and tags it `Stolen`. Entering it
  again scores nothing.
- **Carjack**: entering a traffic car removes its AI. Its driver gets out at the first free door
  as a pedestrian, on the verge on that side, and flees for 4 s. If no door is free, no driver
  appears.
- **Exit**: the player gets out at the first free door, tried in this order: left (the driver's
  side, in Italy), right, front, back. A door is free when it is clear of walk walls with no wall
  between it and the car. If no door is free, the player stays in. The car is left with its
  handbrake on.

Entering or leaving sets the player's velocity to zero. The camera's look-ahead follows velocity,
not the pose, so the hop to the seat or the door does not swing the view.

## Driving

`PlayerDrive` maps the keys to the car's `CarInput`: throttle = up − down, steer = left − right
(left turns counter-clockwise), and Space for the handbrake. `VehiclePhysics`
(`systems/physics.ts`) drives every vehicle, player or AI, from its `CarInput`. The handling is
arcade, in the style of GTA 2:

- Velocity splits into a forward and a sideways part. Sideways slip dies out at the model's
  `grip` rate.
- Throttle against the motion brakes at `brake`. Otherwise the car accelerates at `accel` toward
  `maxSpeed` or `reverseSpeed`. Coasting loses 1.5 m/s² plus 0.06/s × speed.
- Steering reaches full lock only above 6 m/s, is mirrored when reversing, and weakens slightly
  above 15 m/s.
- The handbrake slows the car at 0.35 × `brake`, cuts grip to 0.2× and raises the yaw rate to
  1.4×, which gives drifts.
- The body is a row of circles of radius width/2 along its length. It sweeps against drive walls.
  A hit keeps the sliding part of the motion, bounces back 0.2 of the impact speed, and loses 4%
  of its speed per m/s of impact (keeping at least 20%). A turn that would wedge the body into a
  wall is undone; if any move would, the car stops.
- A parked car that nothing touches sleeps and costs no work.

Vehicles (`src/sim/vehicles.ts`):

| Model | Label | Length × width (m) | Top speed | Reverse | Accel | Brake | Turn | Grip | Mass |
|---|---|---|---|---|---|---|---|---|---|
| `panda` | Fiat Panda | 3.7 × 1.65 | 28 m/s (101 km/h) | 7 | 7 | 14 | 2.4 | 9 | 1 |
| `ape` | Piaggio Ape | 2.9 × 1.4 | 15 m/s (54 km/h) | 4 | 4 | 10 | 2.8 | 7 | 0.6 |
| `truck` | Camion del marmo | 7.6 × 2.45 | 20 m/s (72 km/h) | 4 | 3 | 8 | 1.3 | 10 | 4 |
| `carabinieri` | Alfa Romeo Giulia dei Carabinieri | 4.6 × 1.85 | 42 m/s (151 km/h) | 9 | 11 | 18 | 2.2 | 11 | 1.3 |

Reverse is in m/s, accel and brake in m/s², turn in rad/s at full lock, and grip in 1/s. Mass is
relative and only matters in car-to-car pushes. Adding a model to `VEHICLE_MODELS` fails to
compile until it has stats here and a mesh in `src/render/actors.ts`.

The camera zooms out with speed (6 texels/m in a car, 5 above 16 m/s). The HUD speedometer shows
km/h.

### Horn and siren

H sounds the car's horn while held, from the driver's seat only: on foot it does nothing. In the
Carabinieri Giulia each press of H turns the two-tone siren on or off instead; the siren stops when
the player gets out. Neither has a gameplay effect: nobody gets out of the way. The `horn` binding
is read only by the audio host ([audio.md](audio.md)).

## Traffic AI

`TrafficAI` (`systems/traffic.ts`) drives the cars tagged `Traffic` on `graph.trafficEdges`, using
the lane helpers in `src/sim/route.ts`.

- **Keep right.** The lane offset is w/4 + 0.2 m on roads at least 5 m wide, otherwise 0.5 m. It
  shrinks in 0.25 m steps where houses crowd the road, until the body clears the walls. Each model
  has its own lane table. A model only uses edges where it fits, and where the drive walls across
  the road leave room for it and an oncoming Panda plus 0.3 m (`PASS_MARGIN`): in single-file
  lanes between houses two cars met head-on with no room to back out or turn round. It only uses
  the largest connected part of those edges, so villages reached only by such lanes (Terma, Monte
  dei Bianchi, Vezzanello) get no AI traffic; the player can still drive there. Trucks keep to
  tertiary and unclassified roads and to the loops of that network, because they cannot turn round.
- **Steering.** The car aims at a point 6 m + 0.6 s × speed ahead along this edge and the next.
- **Route choice.** At each node the car picks a random legal edge. Oneways are driven a → b only.
  It avoids dead-end spurs, then hairpins, while another way exists, and makes a U-turn only at a
  dead end.
- **Speed.** Cruising speed by class: tertiary 12 m/s, unclassified 9, residential 7, service 5.
  The car slows before sharp corners (down to 3 m/s) and when pointing away from its target.
- **Braking.** Anything in a cone ahead (8 m + 1.2 s × speed long, 1.8 m half-width), vehicle or
  person, slows the car to keep a 2 m gap. Standing still, it holds the handbrake.
- **Unsticking.** A car stuck below 1 m/s for 3 s reverses for 1.5 s at 3 m/s. If it is lined up
  with its lane, it may turn round: half the time when the way back is not a dead end, always
  from its second try, never on a oneway. Waiting for a person in the way (ahead of the bumper,
  on the carriageway or the verge pedestrians walk) counts four times slower: the car holds about 12 s for them to move on,
  then backs up and turns round like for anything else. A person beside the car or off the road
  counts like any other obstacle.
- **Honking.** Half-way to backing up (`HONK_STEPS`: 1.5 s stuck, about 6 s when waiting for a
  person) the driver honks once, a `Honk` event the audio host plays. It honks again only in a new
  stuck episode: after backing up, or after getting going above 2.5 m/s.
- **Lost.** A car more than 12 m from its edge joins the nearest usable road.

## Pedestrians

`Pedestrians` (`systems/pedestrians.ts`) moves people along `graph.walkEdges`:

- They keep to the verge of roads (w/2 + 0.8 m, on a random side) and to the middle of paths,
  steps and tracks. They walk at 1.3 m/s and turn at random at nodes, turning back only at dead
  ends.
- A vehicle faster than 10 m/s passing within 5 m scares a walker. The walker then runs at
  4.5 m/s along its route, away from the car, for 4 s.
- When blocked (making less than half the wanted progress along the lane), they try the other
  verge after 0.5 s, then turn back, alternating. Stepping across to the other verge is progress;
  sliding sideways along a wall that blocks the way is not.
- Knocked down, they slide to a stop.

## Knockdowns and score

`Contacts` (`systems/contacts.ts`) resolves touching bodies after physics. Nothing is ever shoved
through a wall.

- **Car and car**: they separate by mass share and exchange an impulse (restitution 0.2).
- **Car and standing person**: a car moving into them faster than 3 m/s (`KNOCK_SPEED`) knocks
  them down for 2.5 s. They are thrown with 0.6 of the car's velocity plus 3 m/s away from it.
  Slower, the car pushes them aside. A person pinned against a wall stops the car instead. The
  car's own speed decides, so running into a parked car never floors the runner.
- **Person and person**: they step apart.

The player can be knocked down too, and cannot act until they get up. `Recover` lifts people when
their time is over. A pedestrian then runs from the nearest vehicle for 4 s.

`Score` has two counters, shown on the HUD:

- **Auto rubate** (cars stolen): +1 on the first entry of a vehicle.
- **Persone investite** (people hit): +1 for each knockdown by the car the player is driving.

## Population

`Populate` (`systems/populate.ts`) runs every 0.5 s around the player. It spawns out of view,
farther than `VIEW_REACH` (90 m, the farthest ground the camera shows).

| | Traffic | Pedestrians |
|---|---|---|
| At most | 10 | 22 |
| Spawn distance | 110–220 m (edge midpoint) | 90–120 m |
| Spawns per run | 2 | 3 |
| Despawn beyond | 320 m | 140 m |
| Also despawned, once beyond 90 m | more than 12 m off its road, or 4 unstick tries | blocked for more than 5 s |

- Pedestrians only spawn on walk edges with a building within 50 m of the edge's midpoint
  (`PEOPLED`): the villages and hamlets, not the woods and fields between them. They never spawn
  inside a building, where a verge runs into houses that crowd the road.
- New traffic is 75% Pandas, 15% Apes and 10% trucks, falling back to a smaller model where one
  does not fit. It spawns at least 15 m from any vehicle and clear of walls, heads out of dead-end
  spurs, and starts at 0.6 × cruising speed.
- The player's car is never despawned. Parked, stolen and carjacked cars are not traffic, so they
  stay where they are left.

## Tuning

| Where | What |
|---|---|
| `src/sim/tuning.ts` | `ENTER_GAP`, `PERSON_RADIUS`, `WALK_SPEED`, `SPRINT_SPEED`, `KNOCK_SPEED` |
| `src/sim/vehicles.ts` | `VEHICLES` handling table, `CAR_COLORS` |
| `src/sim/view.ts` | `screenAxes` (screen axes of the home view), `LOOK_AHEAD`, `VIEW_REACH` |
| `src/sim/route.ts` | lane offsets, passing room (`PASS_MARGIN`), pedestrian verge, `cruiseSpeed`, truck road classes, hairpin limit |
| `src/sim/systems/populate.ts` | `TRAFFIC`, `PEDESTRIANS` population limits, `PEOPLED` (where pedestrians spawn), spawn model mix |
| `src/sim/systems/spawn.ts` | parked cars (`PARKED`), trucks (`TRUCKS`) |
| `src/sim/systems/*.ts` | each system's own constants at the top of its file (physics, traffic, pedestrians, contacts, foot, enter/exit) |
| `src/sim/map/kinds.ts` | road widths and which classes carry traffic, the player's car, or only people |
| `src/render/pipeline.ts` | `zoomFor` zoom levels, `turnToward` view turn speed |
| `src/audio/director/levels.ts` | how loud each sound is and how far it carries (see [audio.md](audio.md#known-limits-and-tuning)) |

Gameplay changes need a test: the scenario tests in `src/sim/index.test.ts` and
`src/sim/walls.test.ts` stage exact situations with `src/sim/testing.ts`. Fixtures find map
features by geometry, never by index (`BATTISTI` is the Via Cesare Battisti traffic edge nearest
(-412, 438), eastbound), so they survive map rebuilds. Re-run `pnpm check`
after any change.
