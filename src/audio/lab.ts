/**
 * The audition page (lab.html; the dev server serves it, the production build leaves it out):
 * every synth on a button with its params on controls, played through the real emitter and
 * mixer from a distance and a side of the screen you pick, beside the level, gain, pan and
 * lowpass the acoustics give it there. "Render all" renders every voice and shot offline at a
 * few representative params and tabulates peak, RMS, spectral centroid and NaNs;
 * `window.lab.renderAll()` returns the same rows, for CDP checks.
 *
 * The placement is a stand-in for the director's hearing chain (spreading, air absorption, the
 * cabin, masking; no ground, foliage, occlusion or Doppler), and its levels are display defaults:
 * the director's levels table is the one the game plays.
 *
 * @module audio/lab
 */
import { screenAxes } from "../sim/view.ts"
import { VEHICLE_MODELS, type VehicleModel } from "../sim/vehicles.ts"
import { airCutoff, AMBIENT_DB, audibility, CABIN, type Cabin, delayOf, gainToDb, mixGain, panOf, spreading } from "./acoustics.ts"
import { makeKit } from "./buffers.ts"
import { type Emitter, makeEmitter } from "./emitter.ts"
import { measure } from "./measure.ts"
import { makeMixer, type Mixer } from "./mixer.ts"
import { VEHICLE_SHOTS, VEHICLE_VOICES } from "./synth/vehicles.ts"
import { WORLD_SHOTS, WORLD_VOICES } from "./synth/world.ts"
import type { Continuous, Kit, OneShot, Placement, Shot, Shots, Surface, Voice, VoiceFactory, Voices } from "./types.ts"

const VOICES = { ...VEHICLE_VOICES, ...WORLD_VOICES } satisfies Voices
const SHOTS = { ...VEHICLE_SHOTS, ...WORLD_SHOTS } satisfies Shots

type Sound = Continuous | OneShot

/** The screen axes on the ground, with the view in its home seat. */
const { right: SCREEN_RIGHT, up: SCREEN_UP } = screenAxes(0)

/** A kind's level at its synth's nominal peak: Lp at 1 m, dB(A), heard no closer than `rMin` m; a `bed` is that level at the listener, all around. */
interface Level { readonly db: number; readonly rMin: number; readonly bed?: boolean }

/** Display defaults from the wave-2 brief (physics.md §8). */
const ENGINE_LEVELS = {
  panda: { db: 90, rMin: 2 }, ape: { db: 92, rMin: 2 }, truck: { db: 98, rMin: 4 }, carabinieri: { db: 93, rMin: 2.5 }
} as const satisfies Record<VehicleModel, Level>
/** The listener's own engine from the driver's seat: the voice makes the cabin tone, so no cabin loss. */
const OWN_ENGINE: Level = { db: 82, rMin: 1, bed: true }
// ponytail: water as a point source at its bank level + 6 dB; the director uses places' line-source levels (−3 dB per doubling).
const WATER_LEVELS = { fountain: { db: 65, rMin: 1 }, stream: { db: 70, rMin: 1 }, river: { db: 76, rMin: 1 } } as const satisfies Record<Extract<Continuous, { readonly kind: "water" }>["body"], Level>
const LEVELS = {
  tyres: { db: 98, rMin: 2 }, scrape: { db: 105, rMin: 1 }, horn: { db: 116, rMin: 1 }, siren: { db: 117, rMin: 1 }, beeper: { db: 100, rMin: 1 },
  wind: { db: 60, rMin: 1, bed: true }, crickets: { db: 42, rMin: 1, bed: true },
  crash: { db: 115, rMin: 2 }, thud: { db: 85, rMin: 1 }, door: { db: 82, rMin: 1 }, ignition: { db: 85, rMin: 1 }, honk: { db: 116, rMin: 1 },
  step: { db: 62, rMin: 0.5 }, scream: { db: 100, rMin: 1 }, shout: { db: 88, rMin: 1 }, groan: { db: 72, rMin: 1 },
  bird: { db: 85, rMin: 1 }, bark: { db: 96, rMin: 1 }, bell: { db: 118, rMin: 5 }
} as const satisfies Record<Exclude<Sound["kind"], "engine" | "water">, Level>

const levelOf = (sound: Sound): Level =>
  sound.kind === "engine" ? (sound.inside ? OWN_ENGINE : ENGINE_LEVELS[sound.model]) : sound.kind === "water" ? WATER_LEVELS[sound.body] : LEVELS[sound.kind]

/** The listener's side of the page's controls: the source `r` m away towards `side` (−1 screen-left … 1 screen-right). */
interface Where { readonly r: number; readonly side: number; readonly cabin: Cabin | undefined; readonly wet: number }

/** How `sound` reaches the listener: its placement, level there (dB(A)) and travel delay (only past 40 m, physics.md §6). */
const hear = (sound: Sound, where: Where): { readonly at: Placement; readonly source: Level; readonly level: number; readonly delay: number } => {
  const source = levelOf(sound), r = source.bed ? 1 : where.r, side = source.bed ? 0 : where.side
  const cabin = source === OWN_ENGINE ? undefined : where.cabin
  const loss = spreading(r, source.rMin) + (cabin?.loss ?? 0), level = source.db - loss
  const ahead = Math.sqrt(1 - side * side)
  const pan = panOf(r * (side * SCREEN_RIGHT.x + ahead * SCREEN_UP.x), r * (side * SCREEN_RIGHT.y + ahead * SCREEN_UP.y))
  return {
    at: { gain: mixGain(source.db, loss) * audibility(level, AMBIENT_DB), pan, cutoff: Math.min(airCutoff(r), cabin?.cutoff ?? 20000), cents: 0, wet: where.wet },
    source,
    level,
    delay: r >= 40 ? delayOf(r) : 0
  }
}

const SURFACES = Object.keys({ asphalt: 0, stone: 0, gravel: 0, dirt: 0, grass: 0, leaves: 0 } satisfies Record<Surface, 0>)
/** Menus for the string params. */
const OPTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  model: VEHICLE_MODELS,
  surface: SURFACES,
  body: Object.keys({ fountain: 0, stream: 0, river: 0 } satisfies Record<Extract<Continuous, { readonly kind: "water" }>["body"], 0>),
  species: Object.keys({ robin: 0, tit: 0, blackbird: 0, chaffinch: 0 } satisfies Record<Extract<OneShot, { readonly kind: "bird" }>["species"], 0>)
}
/** Slider [min, max, step] per numeric param, or per `kind.param` where kinds differ. */
const RANGES: Readonly<Record<string, readonly [number, number, number] | undefined>> = {
  speed: [-10, 45, 0.5], "tyres.speed": [0, 45, 0.5], "scrape.speed": [0, 20, 0.5], "crash.speed": [0, 25, 0.5], "thud.speed": [0, 20, 0.5],
  throttle: [-1, 1, 0.05], slip: [0, 10, 0.1], mass: [0.2, 5, 0.1], pitch: [350, 900, 1]
}
const UNIT_RANGE = [0, 1, 0.01] as const

/** Each kind's params as first shown; the controls are made from these (numbers: sliders, strings: menus, flags: checkboxes). */
const HELD = {
  engine: { kind: "engine", model: "panda", speed: 10, throttle: 0.5, inside: false },
  tyres: { kind: "tyres", speed: 12, slip: 0, surface: "asphalt", heavy: false },
  scrape: { kind: "scrape", speed: 8 },
  horn: { kind: "horn", model: "panda" },
  siren: { kind: "siren" },
  beeper: { kind: "beeper" },
  water: { kind: "water", body: "stream", flow: 0.6 },
  wind: { kind: "wind", strength: 0.6, forest: 0.3 },
  crickets: { kind: "crickets", density: 0.7 }
} as const satisfies { readonly [K in Continuous["kind"]]: Extract<Continuous, { readonly kind: K }> }
const PLAYED = {
  crash: { kind: "crash", speed: 8, mass: 1 },
  thud: { kind: "thud", speed: 8 },
  door: { kind: "door", model: "panda", open: false },
  ignition: { kind: "ignition", model: "panda" },
  honk: { kind: "honk", model: "panda" },
  step: { kind: "step", surface: "stone", run: false },
  scream: { kind: "scream", voice: 0.3 },
  shout: { kind: "shout", voice: 0.3 },
  groan: { kind: "groan", voice: 0.3 },
  bell: { kind: "bell", pitch: 600 },
  bird: { kind: "bird", species: "robin" },
  bark: { kind: "bark", big: true }
} as const satisfies { readonly [K in OneShot["kind"]]: Extract<OneShot, { readonly kind: K }> }

/** "Render all": representative params per voice (rendered 2 s) and per shot. */
const VOICE_RENDERS: ReadonlyArray<Continuous> = [
  { kind: "engine", model: "panda", speed: 0, throttle: 0, inside: false },
  { kind: "engine", model: "panda", speed: 15, throttle: 1, inside: false },
  { kind: "engine", model: "ape", speed: 12, throttle: 1, inside: false },
  { kind: "engine", model: "truck", speed: 15, throttle: 1, inside: false },
  { kind: "engine", model: "carabinieri", speed: 40, throttle: 1, inside: false },
  { kind: "engine", model: "carabinieri", speed: 20, throttle: 0.5, inside: true },
  { kind: "tyres", speed: 14, slip: 0, surface: "asphalt", heavy: false },
  { kind: "tyres", speed: 20, slip: 6, surface: "asphalt", heavy: false },
  { kind: "tyres", speed: 10, slip: 0, surface: "stone", heavy: false },
  { kind: "tyres", speed: 15, slip: 3, surface: "gravel", heavy: true },
  { kind: "scrape", speed: 4 },
  { kind: "scrape", speed: 12 },
  ...VEHICLE_MODELS.map((model) => ({ kind: "horn", model }) as const),
  { kind: "siren" },
  { kind: "beeper" },
  { kind: "water", body: "fountain", flow: 0.5 },
  { kind: "water", body: "stream", flow: 0.6 },
  { kind: "water", body: "river", flow: 1 },
  { kind: "wind", strength: 0.3, forest: 0 },
  { kind: "wind", strength: 1, forest: 1 },
  { kind: "crickets", density: 0.3 },
  { kind: "crickets", density: 1 }
]
const SHOT_RENDERS: ReadonlyArray<OneShot> = [
  { kind: "crash", speed: 2, mass: 1 },
  { kind: "crash", speed: 7, mass: 1 },
  { kind: "crash", speed: 15, mass: 1 },
  { kind: "crash", speed: 15, mass: 4 },
  { kind: "thud", speed: 5 },
  { kind: "thud", speed: 12 },
  { kind: "door", model: "panda", open: true },
  { kind: "door", model: "panda", open: false },
  { kind: "door", model: "truck", open: false },
  ...VEHICLE_MODELS.map((model) => ({ kind: "ignition", model }) as const),
  { kind: "honk", model: "panda" },
  { kind: "honk", model: "truck" },
  { kind: "step", surface: "stone", run: true },
  { kind: "step", surface: "asphalt", run: false },
  { kind: "step", surface: "gravel", run: true },
  { kind: "step", surface: "grass", run: false },
  ...(["scream", "shout", "groan"] as const).flatMap((kind) => [0.2, 0.8].map((voice) => ({ kind, voice }))),
  { kind: "bell", pitch: 400 },
  { kind: "bell", pitch: 800 },
  ...(["robin", "tit", "blackbird", "chaffinch"] as const).map((species) => ({ kind: "bird", species }) as const),
  { kind: "bark", big: true },
  { kind: "bark", big: false }
]

const RATE = 48000
/** Voices settle (fade in) for `settle` s, are measured for `seconds`, then stopped: they must be silent `fade` s later, when the speaker frees their emitter. */
const VOICE_RENDER = { settle: 0.5, seconds: 2, fade: 0.5 } as const
/** Room for the longest shot: a bell rings 10 s. */
const SHOT_SECONDS = 12
/** Below this peak a render counts as silent (−80 dBFS); above `CLIP`, as clipping. */
const SILENT = 1e-4, CLIP = 0.95

/** One line of the render table. */
interface Row {
  readonly name: string
  readonly params: string
  readonly peak: number
  /** dBFS. */
  readonly rms: number
  /** Spectral centroid, Hz. */
  readonly centroid: number
  readonly nan: boolean
  /** How long it sounds: the voice's measured span, the shot's own end time. */
  readonly seconds: number
  /** Anything to look at: silent, clipping, NaN, sound after its stop or end. */
  readonly flags: string
}

const paramsOf = (sound: Sound): string => Object.entries(sound).filter(([name]) => name !== "kind").map(([name, value]) => `${name}=${String(value)}`).join(" ")

/** The row for `sound` measured over [from, to] s of `audio`, which must be silent from `quiet` s on. */
const rowOf = (sound: Sound, audio: AudioBuffer, from: number, to: number, quiet: number): Row => {
  const span = (a: number, b: number) => Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c).subarray(Math.floor(a * RATE), Math.floor(b * RATE)))
  const m = measure(span(from, to), RATE), after = measure(span(quiet, audio.duration), RATE)
  const flags = [m.peak < SILENT && "silent", m.peak > CLIP && "clips", (m.nan || after.nan) && "NaN", after.peak > SILENT && `${after.peak.toFixed(4)} after its end`]
  return {
    name: sound.kind, params: paramsOf(sound), peak: Number(m.peak.toFixed(3)), rms: Number(m.rms.toFixed(1)), centroid: Math.round(m.centroid),
    nan: m.nan || after.nan, seconds: Number((to - from).toFixed(2)), flags: flags.filter((flag) => flag !== false).join(", ")
  }
}

const renderVoice = async (kit: Kit, sound: Continuous): Promise<Row> => {
  const { settle, seconds, fade } = VOICE_RENDER, end = settle + seconds
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil((end + fade + 0.05) * RATE), sampleRate: RATE })
  const cents = new ConstantSourceNode(ctx, { offset: 0 })
  cents.start()
  const voice = (VOICES[sound.kind] as VoiceFactory<Continuous>)({ ctx, out: ctx.destination, cents, kit })
  // Frames at 60 Hz, as the director would hold it.
  for (let t = 0; t < end; t += 1 / 60) voice.update(sound, t)
  voice.stop(end)
  return rowOf(sound, await ctx.startRendering(), settle, end, end + fade)
}

const renderShot = async (kit: Kit, sound: OneShot): Promise<Row> => {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SHOT_SECONDS * RATE, sampleRate: RATE })
  const shot = SHOTS[sound.kind] as Shot<OneShot>
  await shot.prepare?.(ctx, kit)
  const end = Math.min(SHOT_SECONDS, shot.play({ ctx, out: ctx.destination, kit }, sound, 0))
  // The speaker frees a shot's emitter 0.1 s after its end.
  return rowOf(sound, await ctx.startRendering(), 0, end, Math.min(SHOT_SECONDS, end + 0.1))
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text?: string): HTMLElementTagNameMap[K] => {
  const node = parent.appendChild(document.createElement(tag))
  if (text !== undefined) node.textContent = text
  return node
}
/** An element of lab.html. */
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

/** Renders every voice and shot offline, prints the table on the page and returns its rows. */
const renderAll = async (): Promise<ReadonlyArray<Row>> => {
  const kit = makeKit(new OfflineAudioContext({ length: 1, sampleRate: RATE }))
  const rows: Array<Row> = []
  // One at a time: a dozen 12 s stereo renders at once would hold hundreds of MB.
  for (const sound of VOICE_RENDERS) rows.push(await renderVoice(kit, sound))
  for (const sound of SHOT_RENDERS) rows.push(await renderShot(kit, sound))
  const table = byId("renders")
  table.replaceChildren()
  const head = element("tr", element("thead", table))
  for (const name of ["sound", "params", "peak", "RMS dBFS", "centroid Hz", "NaN", "s", "flags"]) element("th", head, name)
  const body = element("tbody", table)
  for (const row of rows) {
    const line = element("tr", body)
    for (const cell of [row.name, row.params, row.peak, row.rms, row.centroid, row.nan ? "NaN" : "", row.seconds, row.flags]) element("td", line, String(cell))
    if (row.flags !== "") line.className = "flagged"
  }
  return rows
}

interface Live { readonly ctx: AudioContext; readonly kit: Kit; readonly mixer: Mixer; readonly ready: Promise<unknown> }
let live: Live | undefined

/** The live context, made on the first button press (autoplay policy), with every shot preparing. */
const wake = (): Live => {
  if (live !== undefined) return live
  const ctx = new AudioContext(), kit = makeKit(ctx)
  const ready = Promise.all(Object.entries(SHOTS).map(([kind, shot]) => shot.prepare?.(ctx, kit).catch((error: unknown) => console.error(`lab: preparing ${kind} failed`, error))))
  return (live = { ctx, kit, mixer: makeMixer(ctx), ready })
}

/** A control per param of `defaults` in `box`; returns a reader of the current params. */
const controls = <S extends Sound>(box: HTMLElement, defaults: S): (() => S) => {
  const readers: Array<readonly [string, () => unknown]> = []
  for (const [name, value] of Object.entries(defaults)) {
    if (name === "kind") continue
    const label = element("label", box, `${name} `)
    if (typeof value === "boolean") {
      const input = Object.assign(element("input", label), { type: "checkbox", checked: value })
      readers.push([name, () => input.checked])
    } else if (typeof value === "string") {
      const select = element("select", label)
      for (const option of OPTIONS[name] ?? []) select.add(new Option(option, option, false, option === value))
      readers.push([name, () => select.value])
    } else {
      const [min, max, step] = RANGES[`${defaults.kind}.${name}`] ?? RANGES[name] ?? UNIT_RANGE
      const input = Object.assign(element("input", label), { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) })
      const shown = element("output", label, String(value))
      input.addEventListener("input", () => (shown.textContent = input.value))
      readers.push([name, () => Number(input.value)])
    }
  }
  return () => ({ ...defaults, ...Object.fromEntries(readers.map(([name, read]) => [name, read()])) })
}

/** One panel per sound kind: its controls, a hold or play button, and the readout of how it is heard. */
const panels: Array<{ readonly read: () => Sound; readonly readout: HTMLElement }> = []
const holding = new Map<Continuous["kind"], { readonly read: () => Continuous; readonly voice: Voice<Continuous>; readonly emitter: Emitter }>()

const panel = <S extends Sound>(parent: HTMLElement, defaults: S, label: string, press: (read: () => S, button: HTMLButtonElement) => void): void => {
  const box = element("fieldset", parent)
  element("legend", box, defaults.kind)
  const read = controls(box, defaults)
  const button = element("button", box, label)
  button.addEventListener("click", () => press(read, button))
  panels.push({ read, readout: element("output", box) })
}

const where = (): Where => {
  const value = (id: string) => Number(byId<HTMLInputElement>(id).value)
  const cabin = byId<HTMLSelectElement>("cabin").value
  // The slider is logarithmic: 0.5 m … 2 km.
  return { r: 0.5 * 4000 ** (value("distance") / 1000), side: value("side"), cabin: cabin in CABIN ? CABIN[cabin as VehicleModel] : undefined, wet: value("wet") }
}

const describe = (sound: Sound, at: Where): string => {
  const { at: placement, source, level, delay } = hear(sound, at)
  const gain = placement.gain > 0 ? `gain ${gainToDb(placement.gain).toFixed(1)} dB` : "inaudible"
  return `${source.db} dB(A)${source.bed ? " here" : " @1 m"} → ${level.toFixed(0)} dB(A) · ${gain} · pan ${placement.pan.toFixed(2)} · lowpass ${Math.round(placement.cutoff)} Hz${delay > 0 ? ` · delay ${Math.round(delay * 1000)} ms` : ""}`
}

const build = (): void => {
  const cabin = byId<HTMLSelectElement>("cabin")
  for (const model of VEHICLE_MODELS) cabin.add(new Option(model, model))
  for (const defaults of Object.values(HELD)) {
    panel(byId("held"), defaults as Continuous, "Hold", (read, button) => {
      const { ctx, kit, mixer } = wake(), now = ctx.currentTime, held = holding.get(defaults.kind)
      if (held !== undefined) {
        held.voice.stop(now)
        held.emitter.release(now)
        holding.delete(defaults.kind)
        button.textContent = "Hold"
        return
      }
      // Silent at first: the next frame's placement fades it in.
      const emitter = makeEmitter(ctx, mixer, { ...hear(read(), where()).at, gain: 0 })
      const voice = (VOICES[defaults.kind] as VoiceFactory<Continuous>)({ ctx, out: emitter.input, cents: emitter.cents, kit })
      holding.set(defaults.kind, { read, voice, emitter })
      button.textContent = "Release"
    })
  }
  for (const defaults of Object.values(PLAYED)) {
    panel(byId("played"), defaults as OneShot, "Play", (read) => {
      const audio = wake()
      // The first press waits for the shots' renders.
      void audio.ready.then(() => {
        const { ctx, kit, mixer } = audio, sound = read(), heard = hear(sound, where())
        const emitter = makeEmitter(ctx, mixer, heard.at)
        emitter.free((SHOTS[sound.kind] as Shot<OneShot>).play({ ctx, out: emitter.input, kit }, sound, ctx.currentTime + heard.delay) + 0.1)
      })
    })
  }
  const render = byId<HTMLButtonElement>("render")
  render.addEventListener("click", () => {
    render.disabled = true
    void renderAll().finally(() => (render.disabled = false))
  })
}

/** Every frame: the readouts, the held voices' params and placements, the room, the meter. */
const frame = (): void => {
  // First, so a synth that throws costs one frame, not the loop.
  requestAnimationFrame(frame)
  const at = where()
  byId("distance-shown").textContent = `${at.r < 10 ? at.r.toFixed(1) : Math.round(at.r)} m`
  for (const { read, readout } of panels) readout.textContent = describe(read(), at)
  if (live !== undefined) {
    const now = live.ctx.currentTime
    for (const { read, voice, emitter } of holding.values()) {
      const sound = read()
      emitter.place(hear(sound, at).at, now)
      voice.update(sound, now)
    }
    live.mixer.room({ street: Number(byId<HTMLInputElement>("street").value) }, now)
    const level = live.mixer.level()
    byId<HTMLMeterElement>("meter").value = level
    byId("meter-shown").textContent = `${level.toFixed(1)} dBFS`
  }
}

build()
frame()
Object.assign(window, { lab: { renderAll } })
