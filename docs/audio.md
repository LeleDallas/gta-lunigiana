# Audio

Every sound in the game is synthesised at run time with Web Audio; there are no sample files.
Vehicles, people, the wind, crickets, birds, dogs, church bells and running water all make sound,
and each one reaches the player's ears through a model of outdoor acoustics. A sound gets quieter
and duller with distance, is muffled by houses, hills and woods, shifts in pitch when it moves,
arrives late from far away, and fades out under the background noise. That last step is what lets
the player hear only what is near.

Audio is host code beside render and the HUD (`src/audio`). The simulation never imports it and
only emits two events for it. No sound has a gameplay effect.

## Data flow

```
VehiclePhysics, Contacts ──Impact──┐
TrafficAI ──────────────────Honk───┤
components, Input (horn key) ──────┴─► audio schedule (Lunigiana/Hear) ──Heard──► director
                                                                                     │
                                       hold / play / flush, each with a Placement    │
                                                                                     ▼
          speakers ◄── mixer (reverb, limiter) ◄── emitters ◄── synths ◄── Speaker (Web Audio)
```

1. **Simulation events** (`src/sim/schema.ts`). Two events carry moments that leave no trace in
   the world's state:
   - `Impact` (`hit`, `x`, `y`, `speed`, `mass`, `car`, `other?`): a vehicle hit something this
     step. `VehiclePhysics` emits `wall` for every drive-wall hit faster than 0.05 m/s, with the
     speed lost into the wall (a car wedged so that no move fits emits its whole speed).
     `Contacts` emits `car` when two vehicles close on each other: the closing speed, the reduced
     mass 1/(1/m₁ + 1/m₂), at the contact point (`car` and `other` follow query order, not who
     struck whom). It emits `person` for each knockdown: the car's speed before a pin stops it, the
     car's mass, at the person.
   - `Honk` (`car`, `model`, `x`, `y`): `TrafficAI` emits it once per stuck episode, when a driver
     has been held up for `HONK_STEPS` (1.5 s; see [gameplay.md](gameplay.md#traffic-ai)).
   - The `horn` binding (H) is read only by the audio schedule.

   Events are not saved: snapshots hold components and resources only. Emitting them changes
   neither determinism nor saves (both tests run with the events emitted).
2. **The audio schedule** (`src/audio/index.ts`): one system, `Lunigiana/Hear`, ticked once per
   animation frame. It reads the world and builds one `Heard` (`src/audio/types.ts`):
   - `listener`: the player's pose and velocity, and the vehicle they sit in;
   - `vehicles`: every vehicle that runs (AI traffic, or the player's car) or moves (faster than
     0.01 m/s, or spinning). Parked cars nobody touches are left out;
   - `people`: everyone on foot (pedestrians, and the player when not driving), with their
     fleeing and knocked-down flags;
   - `happenings`: the `Impact` and `Honk` events since its last run, impacts first;
   - `horn`: whether the horn key is held.

   It hands that to the `Audio` service and writes nothing (`src/render/index.test.ts` checks it).
   It does no acoustics. Once a system has run, it receives every event of the update steps
   between two frames; `main.ts` ticks the schedule once right after `setup`, so the first steps'
   events are not lost.
3. **The director** (`src/audio/director`) is the `Audio` service: plain TypeScript, tested in
   Node. Each frame (`index.ts`) it:
   - places the ears 1.6 m above the ground under the listener (a bridge deck, not the river under
     it) and notes the cabin around them;
   - asks the world part for the masking floor and how enclosed the street is (`world.ts`), and
     every 1 s or 10 m looks up the slopes that echo;
   - lets its vehicle (`vehicles.ts`), people (`people.ts`) and world (`world.ts`) parts place
     their sounds through the acoustic chain (`hearing.ts`);
   - plays one-shots at once (with their echoes), and keeps the loudest offered continuous voices
     of each kind up to its cap (`frame.ts`);
   - re-measures a few stale obstacle paths (`occluder.ts`) and flushes the speaker.

   Time is the speaker's clock. Before the AudioContext exists it reads 0: the director still
   tracks who sits where, but measures and plays nothing. A frame longer than 0.25 s counts as a
   stall, not as time passing.
4. **The speaker** (`src/audio/speaker.ts`) plays the requests with Web Audio. `hold(key, sound,
   at)` keeps one live voice per key, built from the `Voices` table on the first frame it is held
   and updated every frame after; at `flush` every voice not held since the last flush fades out
   and is freed. `play(sound, at, delay)` schedules a one-shot from the `Shots` table. At most 32
   one-shots play (or wait to) at once: a new one replaces the quietest if it is louder, else it is
   dropped. A synth that throws is logged once and that kind is muted for the session; the game
   loop never sees the error.
5. **Emitters and the mixer.** Each voice or one-shot plays through its own emitter
   (`emitter.ts`): a lowpass (Butterworth, at the placement's cutoff), the placement gain, a
   stereo pan, and a send to the shared reverb. A started `ConstantSourceNode` carries the Doppler
   shift in cents into the synth's detunes. Gain, pan, send and pitch glide with a 50 ms time
   constant, the cutoff with 100 ms. The mixer (`mixer.ts`) sums the dry signals and the reverb
   return into a master gain (0.8), then a limiter (threshold −6 dBFS, knee 6 dB, ratio 12, attack
   3 ms, release 250 ms, its built-in makeup gain of 2.14 dB trimmed off), an analyser for the
   level meter, and the output.

## Where state lives

- **Nothing is saved.** The events are transient, and the audio host never writes the world.
- **The director's memory**, all of it per entity and pruned:
  - vehicles: the listener's car and the running vehicles of the last frame (to hear getting in,
    getting out and the starter), the horn key's last state (the siren toggles on a press),
    engines still cranking, sirens on, each car's last crash (to merge one hit's steps) and the
    cars scraping. Each entry ends when its time is over or its vehicle stops running;
  - people: per person on foot, the last position, the step phase, the mood and the last voice
    cue. A person not heard in a frame (despawned, or the player now in a car) is dropped;
  - the valley: the water and dogs near the ears (looked up again every 0.25 s or 2 m), the eased
    street, the loudest water heard last frame, the last bell ring and its strokes to come;
  - the occluder: the obstacles of each source's path, forgotten 2 s after nobody asks for them;
  - the echoes around the ears, looked up again every 1 s or 10 m.
- **The speaker:** the live voices by key, the one-shots playing, and the kinds muted after a
  failure.
- **Static data** never changes once built. The bells are found at load; the ambience grid, the
  water reaches and the dogs in the first `hear`, during the audio tick after `setup` (≈ 65 ms in
  Node, ≈ 40 of it the cover raster, which the browser has already built for the renderer); the
  road-surface index on the first footstep or tyre. The land-cover raster is the renderer's
  (`mapCover()` in `src/render/landcover.ts`, built once and shared).
- **Randomness** in the director (birds, dogs) and the synths (variants, jitter) is `Math.random`:
  `?seed=N` replays the world, not the birds.

## How sound travels

`hearing.ts` runs one chain per source, every loss in dB relative to the source's level at 1 m,
summed and converted once:

- level at the ears = level at 1 m − spreading − ground − foliage − diffraction − cabin;
- gain = `mixGain(level at 1 m, losses)` × `audibility(level at the ears, floor)`;
- lowpass = the lowest of the air, diffraction and cabin cutoffs;
- pitch = the Doppler shift (vehicle voices only);
- reverb send = from the street around the ears and the distance.

Distances are three-dimensional. The ears are 1.6 m above the ground; sources stand at their own
height above theirs: a vehicle 0.8 m, a person 1 m, water 2 m (lifted out of its carved bed), a
bell at its tower's top, a bird 6–12 m up a tree, a dog 0.5 m.

Each class of sound behaves differently:

| Class | Source | Doppler | Waits its travel time | Echoes | Occluded |
|---|---|---|---|---|---|
| Vehicle voices: engine, tyres, horn, siren, beeper, scrape | point | yes | no (continuous) | no | yes, except the player's own car |
| Vehicle one-shots: crash, thud, door, ignition, honk | point | no | past 40 m | crashes from 6 m/s, honks | yes, except the player's own crashes, doors and starter |
| People: steps, scream, shout, groan | point | no | past 40 m | screams, shouts | yes, except the player's own steps |
| Water | line (rivers, streams), point (fountains, the Cascata di Equi) | no | no (continuous) | no | yes |
| Birds, dogs, bells | point | no | past 40 m | barks, bells | yes |
| Wind, crickets | a bed at the ears, centred | no | no | no | no (through the cabin only) |

### Point and line sources

- **Point sources** lose 20·log10(r) dB: 6 dB per doubling of distance. Inside `rMin`, the
  source's size, they get no louder (the calibration table gives it per kind).
- **Rivers and streams are line sources** (`lineLevel` in `acoustics.ts`): each water piece is a
  polyline of incoherent segments, and the level at the ears is the exact sum
  Lp = 10·log10 Σ 10^(Lw′/10)·θ/(4π·d), with d the distance to each segment's line (at least 1 m)
  and θ the angle it subtends. Close to a long reach that falls 3 dB per doubling; far away, 6.
  Pieces of one named river are one body, heard from its nearest point.
- **Water loudness** (`places/water.ts`): each reach's sound power Lw′ comes from the water's
  width (a stand-in for discharge) and its grade smoothed over ±40 m (rapids against calm
  reaches), calibrated at 2 m from the bank: the Torrente Lucido ≈ 70 dB(A) in rapids and ≈ 62 on
  calm reaches, the 8 m torrents ≈ 64, the 4 m named streams ≈ 55, the unnamed 2 m gullies ≈ 40.
  Drinking fountains, taps and the Fontana di Aiola lavoir are point sources of 65 dB(A) at 1 m,
  and the Cascata di Equi (hard-coded at (1835, 530): only the raw OSM has it) one of 80. Bodies
  within 400 m are looked up; those under 20 dB(A) at the ears, even in the clear, are left out.

### Air absorption

Air absorbs high frequencies first, so distance is a lowpass, not a level loss. The cutoff is where
absorption reaches 3 dB (ISO 9613-1, 15 °C, 70 % relative humidity), log-log between the rows:

| Distance | 6 m | 10 m | 25 m | 50 m | 100 m | 200 m | 500 m | 1 km | 2 km |
|---|---|---|---|---|---|---|---|---|---|
| Cutoff | 20 kHz | 15.1 kHz | 9.1 kHz | 6.3 kHz | 4.3 kHz | 2.9 kHz | 1.5 kHz | 680 Hz | 315 Hz |

### Ground and foliage

- **Ground effect** over soft ground (ISO 9613-2 §7.3.2): max(0, 4.8 − (2h/r)(17 + 300/r)) dB,
  h the mean height of the path above the terrain at both ends. Up to 4.8 dB at a distance.
- **Foliage** (ISO 9613-2 Annex A, at 1 kHz): the metres of forest on the straight path (sampled
  every 8 m on the cover raster) cost nothing under 10 m, 1 dB for 10–20 m, then 0.06 dB per
  metre, at most 12 dB.

### Buildings and terrain

`occlusion.ts` finds the worst edge between source and ears: building walls up to their eaves
(`z0 + h`; the outline's exact crossings, found through the shared building grid) and the terrain
sampled every 7 m (3 m in from each end). The edge with the largest Maekawa path difference
δ = |ST| + |TR| − |SR| wins; `diffraction` turns it into a loss and a lowpass (the 250 Hz Maekawa
value, and a cutoff matching the tilt):

| δ | 0 | 0.05 m | 0.1 m | 0.25 m | 0.5 m | 1 m and more |
|---|---|---|---|---|---|---|
| Loss | 0 | 6.5 dB | 7.7 dB | 10.1 dB | 12.5 dB | 15 dB |
| Cutoff | 20 kHz | 1.8 kHz | 1.5 kHz | 1.4 kHz | 1.9 kHz | 2.8 kHz |

- A building an endpoint stands in hides nothing from it: a bell at the top of its tower rings
  out over its own walls.
- Trees, water banks and the sim's collision walls are not edges (trees count as foliage).
- Paths are cached per source (`occluder.ts`): a new source is measured at once; a known one keeps
  its value until a refresh, at most every 150 ms, at most 12 a frame (oldest first), and only if
  someone asked for it since. A source too faint to hear even in the clear is never measured.

### Doppler

Vehicle voices shift with the motion of both ends: f′/f = (c − v_L·u)/(c − v_S·u), u the unit
vector from source to listener, c = 340.4 m/s (15 °C), the ratio clamped to 0.7–1.4 and no shift
within 1 m. A car at 12 m/s coming straight at the player sounds 62 cents sharp; at 42 m/s,
+228 cents approaching and −201 receding. Water, the beds and one-shots do not shift.

### Propagation delay

One-shots farther than 40 m start r/c later: 0.29 s from 100 m, 0.88 s from 300 m. Nearer, the lag
(under about 120 ms) goes unnoticed, so they play at once (ITU-R BT.1359). Continuous voices are
never delayed.

### Inside a vehicle

From the driver's seat, outside sounds pass the body's insertion loss: 15 dB and a 1.4 kHz lowpass
in the closed cabins (Panda, truck, Giulia), 6 dB and 3.5 kHz in the Ape's cab, open at the back.
Sounds of the player's own car are heard from inside it:

- the engine has its own fixed level (82 dB(A), centred, no Doppler), and its voice switches to
  the cabin tone behind the firewall (a 2.5 kHz lowpass and +4 dB at 120 Hz);
- the horn and siren pass half the cabin (7.5 dB, a 5.3 kHz lowpass);
- its crashes, scrapes, doors, starter and the thud of a person it hits pass none;
- the tyres, the truck's beeper and the beds pass the whole cabin.

### Masking and proximity

Every sound is heard against a floor: the energy sum of the rural daytime background (35 dB(A),
`AMBIENT_DB`), the loudest water heard in the last frame (occlusion included, so a river behind
houses masks only as loud as it sounds) and the wind. A sound at most 5 dB under the floor plays
at full gain. Below that it fades linearly in dB, and 15 dB under the floor it is culled: a
one-shot is dropped, a voice is no longer held and fades out. The margin is there because a
narrow-band sound stays detectable 5–10 dB under a broadband dB(A) floor.

The wind's strength rises with altitude, from 0.15 on the valley floor to 0.85 at 1,000 m
(a smoothstep from 150 m), up to 0.15 more on open ground, and 0.3 less in a street. Its level is
60 + 40·log10(strength) dB(A): it adds nothing in Monzone's streets (floor 35), brings open ground
on the valley floor to about 40, and makes the floor about 57–60 dB(A) on the ridges.

Over flat, open ground with nothing in the way, at the 35 dB(A) floor:

| Source (dB(A) at 1 m) | Full level up to | Silent beyond |
|---|---|---|
| walking step (58) | 22 m | 52 m |
| running step (62) | 30 m | 80 m |
| groan (72) | 80 m | 240 m |
| shout (88) | 460 m | 1.5 km |
| Panda engine at full load (90) | 580 m | 1.8 km |
| scream (100) | 1.8 km | 5.8 km |
| crash, horn, bell (115–118) | over 10 km | |

At a ridge's 57 dB(A) floor every radius is about ten times shorter. In the valley the obstacles
shorten them more (a house or a spur in the way takes up to 15 dB, the woods up to 12), and so do
the sim's ranges: traffic despawns beyond 320 m and pedestrians beyond 140 m. Far sounds are faint
in the mix long before they are culled.

### Voice caps

At most this many continuous voices of each kind play, the loudest at the ears first:

| `engine` | `tyres` | `scrape` | `horn` | `siren` | `beeper` | `water` | `wind` | `crickets` |
|---|---|---|---|---|---|---|---|---|
| 8 | 4 | 2 | 3 | 2 | 2 | 4 | 1 | 1 |

A voice held in the last frame ranks 3 dB louder (`KEEP_DB`), so two near-equal engines do not swap
every frame (each swap would build a new voice). At the hour, only the 4 loudest bell towers in
earshot ring (`TOWERS`).

### Echoes

Loud impulsive one-shots answer off the slopes (`echoesAt` in `places.ts`): crashes from 6 m/s,
honks, barks, shouts, screams and bells. The search runs along 16 directions from 40 to 400 m in
8 m steps and takes the first face the listener can see (rising above every sight line before it)
that climbs at least 35° and stands at least 10 m above the ears. Up to two echoes play, the
strongest first and at least 45° apart:

- delay 2d/c after the direct sound;
- loss 20·log10(2d) + air absorption (0.0041 dB/m at 1 kHz) + reflection: 6 dB off bare rock (a
  face steeper than 50°, or not forested), 15 dB off a wooded slope; always at least 6 dB under
  the direct sound;
- panned toward the face, low-passed at the direct sound's cutoff or the echo path's air cutoff,
  whichever is lower, with twice the direct sound's reverb send;
- skipped when the masking rule would cull it.

Buildings are not echo faces, so village streets get reverb, not echoes.

### Street reverb

`streetAt` measures how enclosed the ears are: 8 directions out to 15 m, each counting the facade it
meets by its height above the listener's ground (4 m and more count fully). The mean, 0 (open) to 1
(a narrow stone street), eases with a 0.5 s time constant and crossfades (equal power) two
generated impulse responses: the open valley's (2.6 s long, RT60 2 s, 30 ms pre-delay) and a stone
street's (1.2 s, RT60 0.9 s, 10 ms). A fully wet send returns 12 dB under the dry sound. Each
source's send is −12 dB in the open and 0 dB in a narrow street, rising with distance from 10 m up
to 4× at 40 m (the direct sound falls 6 dB per doubling, the reverberant field less), and a
quarter inside a vehicle. The beds send 0.1.

### Stereo

The pan is the source's direction along the screen's right axis (`SCREEN_RIGHT`), scaled to ±0.85
so nothing sits in one ear only, and fading to the centre within 2 m. The camera never turns, so a
car on the right of the screen is heard on the right. There is no front and back.

## Sound catalogue

Levels are dB(A) at 1 m at the synth's nominal peak, with the source's size `rMin` in brackets.

Continuous voices (held every frame they play):

| Kind | Made of | Plays when | Level |
|---|---|---|---|
| `engine` | `synth/engine.ts`: an oscillator at the firing frequency (a sawtooth, or a band-limited pulse for the Ape's two-stroke and the truck's diesel), a half-order sub, a waveshaper driven by the load, two exhaust formants, noise gated at the firing rate, and a turbo whine on the truck and the Giulia. Revs come from a virtual gearbox per model (`gearbox.ts`) | a vehicle runs (AI traffic, or the player at the wheel), once its starter, if any, has caught | at full load: Panda 90 (2 m), Ape 92 (2 m), truck 98 (4 m), Giulia 93 (2.5 m); the player's own 82 from the seat |
| `tyres` | `synth/tyres.ts`: rolling noise rising as (v / 70 km/h)^1.5, a sett rumble at v / 0.14 m on stone, a two-tone squeal (980 and 1460 Hz) on asphalt and stone when sliding, a gravel crunch on loose ground; the truck's 6 dB louder and darker | a vehicle moves faster than 1 m/s. The surface is the road's OSM surface on a carriageway (or within 0.5 m of its edge), else the land cover's | 98 (2 m) |
| `scrape` | `synth/impacts.ts`: band-passed noise, ringing panel modes, grit and a stick-slip judder | a car hits a wall at under 1.5 m/s while still moving faster than 2 m/s; held 0.2 s past the last such hit | 105 (2 m) |
| `horn` | `synth/horns.ts`: Panda 420 Hz, Ape 610 Hz, truck air horn 150 + 185 Hz, Giulia 410 + 500 Hz | the player holds H at the wheel of anything but the Giulia | 116 (2 m) |
| `siren` | `synth/horns.ts`: the Italian *bitonale*, 466 and 622 Hz for 0.75 s each (D.M. 20/03/1979) | toggled by H in the Giulia the player drives; it stops when they get out | 117 (2.5 m) |
| `beeper` | `synth/horns.ts`: a 1 kHz tone, 0.5 s on and 0.5 s off | a running truck reverses (faster than 0.3 m/s backwards) | 100 (2 m) |
| `water` | `synth/water.ts`: bubbles ringing at their Minnaert frequency (van den Doel's model, `synth/bubbles.ts`), a pink-noise bed, and in rivers a boulder rumble and a slow surge. `body` is `river` (OSM rivers, and water 8 m wide or more), `stream` or `fountain`; `flow` comes from width and grade | the 4 loudest bodies within 400 m | from the water's level at the ears (above) |
| `wind` | `synth/nature.ts`: a brown-noise band breathing with gusts, a whistle on strong gusts, leaves in proportion to the forest around | always, one bed | 60 at the ears at strength 1 |
| `crickets` | `synth/nature.ts`: six Italian tree crickets (*Oecanthus pellucens*) on a 2.6 kHz carrier, 0.59 echemes (chirps) a second (Dolbear's law at the game's fixed 15 °C October afternoon) | open ground outweighs buildings around the ears (`open − built` > 0) | 42 at the ears at density 1 |

One-shots:

| Kind | Made of | Plays when | Level |
|---|---|---|---|
| `crash` | `synth/impacts.ts`: three tiers (light under 4 m/s, medium under 10, heavy) × three variants rendered offline; loudness (speed / 15)^1.2 with a floor; a heavier mass plays lower | a `wall` or `car` Impact of 1.5 m/s or more. One hit spans a few steps: within 0.1 s of a car's crash only a 1.5× harder hit plays again | 115 (2 m) |
| `thud` | a low thump and a cloth swish, full level from 12 m/s | a `person` Impact (a knockdown) | 85 (1 m) |
| `groan` | `synth/voices.ts`, a formant voice | 0.25 s after a thud, from the person hit | 72 (1 m) |
| `door` | per model: opening (latch clicks, the seal), closing (thump, latch, panel ring) | the player gets in (open, then close 0.7 s later) or out (at their new spot) | 82 (1 m) |
| `ignition` | the starter whirring with a dip at each compression, then the engine catching | the player gets into a car whose engine was off; the engine voice takes over after `CRANK` (Panda 0.8 s, Ape 0.4 s, truck 1.5 s, Giulia 0.6 s). Carjacking a running car plays doors only | 85 (1 m) |
| `honk` | one long or two short presses of the model's horn | a `Honk` event | 116 (2 m) |
| `step` | `synth/steps.ts`: heel then ball, per surface (asphalt, stone, gravel, dirt, grass, leaves) and gait, four variants each, played ±8 % in rate and ±2 dB | everyone on foot, at 2 steps a second at a 2.2 m/s walk and 3 at a 5.5 m/s sprint, counted from the distance actually moved (none while down, none for a jump of more than 3 m in a frame); a run above 3.5 m/s. The player's steps come from under the ears | 62 (0.5 m) for a running step on stone; walking 4 dB under |
| `scream`, `shout` | `synth/voices.ts`: a sawtooth glottis on a pitch contour, breath noise, three vowel formants and a fast roughness; each person keeps one voice (sex and pitch from their id) | a pedestrian starts to flee (scared by a fast car, or back on their feet after a knockdown) screams or shouts "Ehi!"; a carjacked driver within 15 m shouts. At most one cue per person per 4 s | scream 100 (1 m), shout 88 (1 m) |
| `bell` | `synth/nature.ts`: a bell's inharmonic partials (hum, prime, tierce, quint, nominal...), each split to beat; four primes rendered, any pitch resampled from the nearest | the computer's local clock: the hours (1–12 strokes, 2.5 s apart) on the hour and one stroke on the half hour, from the 4 loudest towers in earshot, each starting up to 6 s late | 118 (5 m) |
| `bird` | `synth/nature.ts`: autumn calls of the robin, great tit, blackbird ("chink" or "seee") and chaffinch ("pink"), 35/30/20/15 % | from a tree 15–70 m away: 0.3 calls a second in full forest, plus 0.05 near houses | 85 (1 m) |
| `bark` | `synth/nature.ts`: two to five barks of a big or a small dog through a formant tract | 183 farm dogs (about one in eight barns, sheds, houses and farm buildings with open ground and no paving 5 m out): those within 200 m bark every 45 s on average, four times as often while the player runs or drives within 30 m | 96 (1 m) |

The bells are the tallest church or tower of each district, 22 in all. A tower of 10 m or less
rings an 800 Hz prime; taller towers ring lower, down to 400 Hz at 30 m.

## Calibration and mix

`src/audio/director/levels.ts` is the mix's one calibration table:

- `ENGINE`, `OWN_ENGINE_DB` and `LEVELS`: each kind's level at 1 m and size, as in the catalogue.
  Every synth peaks near 0.5 (−6 dBFS) at the loudest params it is meant for and scales itself
  with its physical params: an engine idles about 20 dB under full load at the redline, tyres
  follow the rolling law, a crash its speed. The level in the table is the one at that peak.
- `BEDS`: the wind and cricket beds at the ears at full strength and density. `WALK_DB`, `windDb`
  and `cricketsQuiet`: how far the step, wind and crickets synths play under that, so masking
  counts the sound actually played.
- `HEIGHT`, `WATER_R_MIN`: source heights and the water's 1 m clamp.
- `CAPS`, `KEEP_DB`, `TOWERS`: the voice caps and their hysteresis.
- `DELAY_FROM` (40 m), `REVERB`, `ECHO` and `echoes(sound)`: delay, reverb sends and echoes.

`mixGain` (`acoustics.ts`) turns a level into a gain. Real levels span 54 dB from a running step
to a horn, too much for a game mix, so only the source levels are compressed, around 120 dB(A) by 0.6;
the losses on the way stay physical, so distance and occlusion cues keep their size:

gain = 10^((120 + 0.6·(L1m − 120) − losses − 111.58) / 20)

The 111.58 (`FULL_SCALE`) puts a 116 dB(A) horn heard from 2 m at gain 1: its synth's nominal peak.
After compression a horn is 32 dB above a running step at 1 m instead of 54. Louder sums rely on the
master limiter. A number in the table moves one kind against the others and nothing else.

## Controls

| Key | Where | Does |
|---|---|---|
| H | at the wheel | sounds the horn while held |
| H | at the wheel of the Carabinieri Giulia | each press turns the two-tone siren on or off |

On foot H does nothing. The title card lists it.

## Start, pause and hidden tabs

- **Autoplay.** Browsers allow audio only after a user gesture, so the AudioContext is made on the
  first trusted `keydown`, `pointerdown` or `touchend` with user activation: the same first key
  that dismisses the title card (Esc does not count). Until then nothing plays and no sound time
  passes. A later gesture resumes a context the browser has left suspended or interrupted (Safari,
  Firefox).
- **Pause.** While the full map (M) is open, `main.ts` calls `speaker.pause(true)` every frame,
  which suspends the context, and skips the frame, so the audio schedule does not run either.
  Closing the map resumes both.
- **Hidden tab.** The context is suspended while the page is hidden and resumed when it shows
  again (unless the map is open).
- **Failures.** A non-finite placement or delay is never sent (it would mute its kind for the
  session); a synth that throws mutes only its own kind.

## The audition page

`pnpm dev` also serves the audition page at http://localhost:5173/lab.html (`lab.html`,
`src/audio/lab.ts`); the production build leaves it out. It plays every synth through the game's
own emitter and mixer:

- **Listener:** the distance (a logarithmic slider, 0.5 m to 2 km), the side of the screen, a cabin
  (none or a model), the reverb send, the street room, and the master level meter.
- **One panel per kind:** each continuous kind has Hold / Release and each one-shot Play, with a
  control for every param (sliders, menus, checkboxes). Each panel shows how its sound is heard at
  that spot: the level at 1 m and at the listener, the gain, pan, lowpass and delay. The first press
  starts the audio.
- **Render all** (also `window.lab.renderAll()`, which returns the rows) renders every voice and
  shot offline at 48 kHz at a few representative params (59 renders, about 2 s) and tabulates peak,
  RMS (dBFS), spectral centroid (`measure.ts`), NaNs and length. It flags silence (peak under
  1e-4), clipping (over 0.95), NaNs, and any sound left after a voice's stop or a shot's end.
  Adding a kind fails to compile until the page has a panel and render rows for it.

The page's placement is a stand-in for the director's chain (spreading, air absorption, the cabin
and masking against 35 dB(A); no ground, foliage, occlusion or Doppler; water as a point source),
and its levels table is a display copy. The game plays `levels.ts`.

## Tests

`pnpm test` runs them all in Node, which has no Web Audio: the synth modules make nodes only inside
functions (`synth/world.test.ts` imports them to check).

| File | Checks |
|---|---|
| `src/sim/index.test.ts`, `src/sim/walls.test.ts` | the events: a car driven into a building is a `wall` Impact at the wall; a car rolling into a parked one a `car` Impact at the closing speed, the reduced mass and where the bumpers meet; a knockdown one `person` Impact faster than `KNOCK_SPEED`; a car pinning the player a `person` Impact as fast as the car was; a car blocked by a parked one honks once per stuck episode, `HONK_STEPS` before each time it backs up |
| `src/audio/index.test.ts` | `Hear`: the listener on foot and at the wheel with the horn held, AI traffic running while standing, an untouched car heard only while it moves, impacts then honks each heard once |
| `src/render/index.test.ts` | every system of the render and audio schedules declares no writes |
| `src/audio/acoustics.test.ts` | the laws: the line source against the exact table, the air cutoffs, Doppler, the pan, diffraction, ground, foliage, masking, the mix calibration |
| `src/audio/occlusion.test.ts` | path differences on real map spots: a flat meadow, Monzone Alto's 30 m tower, a bell over its own walls, Monte San Giorgio between its flanks |
| `src/audio/places.test.ts`, `src/audio/places/water.test.ts` | surfaces, ambience shares, streets, echoes at Equi Terme, bells, dogs and birds, the Torrente Lucido from Monzone station, the Fontana di Aiola |
| `src/audio/director/index.test.ts` | the director on a recording speaker at real map spots: proximity, a building's muffling, Doppler, step cadence, travel delay, crash merging and scrapes, echoes, nothing before the context, the cabin, getting in and out, horn and siren, the bells, water and its masking, voice caps and their hysteresis, flee cues |
| `src/audio/director/hearing.test.ts`, `occluder.test.ts` | the reverb send; the obstacle cache's refresh and forgetting |
| `src/audio/speaker.test.ts`, `mixer.test.ts`, `buffers.test.ts`, `measure.test.ts` | the one-shot cap, the speaker inert until a trusted gesture, the reverb crossfade, the level meter, seamless noise loops, the render measurements |
| `src/audio/gearbox.test.ts`, `src/audio/synth/*.test.ts` | gearbox shifts; the engine, tyre and crash laws; step and cricket rates; bubbles at their Minnaert frequency; synth params clamped, NaN to silence |

### In a browser

1. `pnpm dev`, open http://localhost:5173 and press a key: it dismisses the title card and starts
   the sound.
2. In the console (dev builds only), `gta.audio.context()?.state` should read `"running"`, and
   `gta.audio.level()` returns the master's RMS in dBFS (−100 when silent). `gta.audio.speaker` is
   the speaker: wrap its `hold` and `play` to count requests or check placements.
3. The Ritmo monitor (backslash) lists the audio schedule beside `update` and `render`.

Measured in headless Chrome (`?seed=3`, keys sent over CDP): standing at the spawn −83 dBFS,
walking to the nearest car −63, in the Carabinieri Giulia idling −47, driving at 13 m/s −29, with
the siren on −27; no console errors and no non-finite placement or param. On the audition page
"Render all" gives 59 rows, none flagged.

## Known limits and tuning

- **On foot the mix is quiet.** In a village street the wind bed is about 10 dB(A), and the
  35 dB(A) background is a masking floor that is never played, so standing at the spawn the output
  sits some 54 dB under driving (see above). It needs a listening pass. The knobs: `BEDS` and the
  wind constants in `director/world.ts`, or the mix rule's centre and slope in `acoustics.ts`.
- **Engines mask and rank at full load.** Masking and the voice caps count an engine at its
  full-load level whatever its throttle; the synth plays an idle about 20 dB quieter, so an
  idling car is culled later than physics says.
- **One edge.** Only the worst edge on the path counts, capped at 15 dB: two rows of houses are no
  quieter than one. Trees cost foliage loss but do not diffract.
- **Echoes inherit the direct path's occlusion**, and only terrain faces echo.
- **Bells follow the computer's clock**, not a game time of day. A ring that falls before the
  audio starts is skipped.
- **Fixed weather:** 15 °C, 70 % humidity, an October afternoon. No night, no wind direction.
- **Water** loudness comes from width and grade, not discharge; the Cascata di Equi is hard-coded.
- **Stereo** is a pan along the screen's right axis, with no front or back.
- **The occluder is bounded:** at most 12 paths a frame are re-measured, each at most every
  150 ms, so a source moving fast behind houses can lag a few frames.
- **A car rubbing along a wall** keeps a faint scrape held while the sim reports the small hits.
- **The audition page** keeps its own copy of the levels: it can drift from `levels.ts`.

Where to tune:

| Where | What |
|---|---|
| `src/audio/director/levels.ts` | every source level and size, heights, caps and hysteresis, the bell towers, delay, reverb and echo sends |
| `src/audio/acoustics.ts` | `AMBIENT_DB`, `CABIN`, the mix rule (`L_REF`, `K`), the air and diffraction tables |
| `src/audio/director/vehicles.ts` | when tyres roll, the beeper sounds, a hit crashes or scrapes, hits merge; the groan and door timings |
| `src/audio/director/people.ts` | jumps, running, the shout radius and the cue gap |
| `src/audio/director/world.ts` | the wind law, birds, dogs, the bell strokes, how often water and dogs are looked up |
| `src/audio/director/occluder.ts` | the obstacle refresh rate, per-frame budget and forgetting |
| `src/audio/places.ts`, `src/audio/places/water.ts` | surfaces, ambience, street probes, the echo search, bells, dogs, bird trees; water power, fountains and the Cascata |
| `src/audio/mixer.ts`, `src/audio/speaker.ts` | master gain, limiter, the two reverbs and their return; the one-shot cap |
| `src/audio/gearbox.ts`, `src/audio/synth/*.ts` | each synth's own table: gear ratios, engines, horns, tyre grounds, treads, voices, calls, bubbles |

Sources for the numbers: ISO 9613-1 (air absorption) and ISO 9613-2 (ground effect, foliage),
Maekawa's barrier chart (diffraction), ITU-R BT.1359 (audio lag), D.M. 20/03/1979 (the siren),
CNOSSOS-EU (tyre rolling noise), van den Doel 2005 (bubbles), Farnell, *Designing Sound*
(footsteps, wind), Peterson and Barney 1952 (vowel formants), Arnal et al. 2015 (the roughness of
screams) and Dolbear's law (cricket rate).
