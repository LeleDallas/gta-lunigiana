/**
 * A crash rendered from what met (crash research DESIGN.md; critique.md is the measured target). Each
 * body crunches: dense Gaussian band noise (overlapping buckle grains, thousands a second) whose
 * power follows the crush rate cos(πt/T) inside the crush pulse T, held by the rebound and continued
 * deformation for the 150–400 ms main block, with 1–3 sub-hits, ringing on in a dense modal field
 * that decays per band with T60 = 2.2 / (f·η); 3–30 power-law major buckles stand out of it, each a
 * bright burst and a few freshly drawn panel modes; 1–3 stiff parts ring as long partials. Then what
 * breaks and falls (parts.ts), what was hit (targets.ts), and from the cabin its boom-heavy balance.
 * One level law, applied once: the render's gain is `levelOf` (hit.ts).
 *
 * @module audio/synth/crash/render
 */
import { BANDS, between, excite, halfSine, type Mix, noiseFor, playNoise, power, powerLaw, puff, ramp, rayleigh, type Spectrum, strike, tint } from "./dsp.ts"
import { type Crash, type Crushed, type Hit, hitOf, levelOf } from "./hit.ts"
import { aftermath, breakage } from "./parts.ts"
import { TARGETS } from "./targets.ts"

// Spectra, dB per octave band 31.5 Hz … 16 kHz.
/** The crunch (critique §4.3): flat within ~5 dB over 125 Hz–2 kHz, 4 kHz ≈ −9, 8 kHz −14…−22, 16 kHz −24…−34, 63 Hz −8…−17: no boom outside. (Measured octaves read a little brighter than the bands: each band spans two.) */
const CRUNCH = [-24, -15, -2, 0, -2, -3, -4, -10, -23, -38]
/** No crumple yet (a bump): the cover rubbing over its foam, darker, peaking near 250 Hz like the bumper taps b1 and b2. */
const RUB = [-30, -16, -4, 0, -2, -6, -8, -13, -24, -38]
/** A buckle's burst re the body's crunch: snaps excite the panels' 1–4 kHz modes. */
const SNAP = [-10, -8, -5, -3, -1, 0, 0, -1, -3, -6]
/** A side hit: the door skin, no crash box, crunches brighter. */
const SIDE = [0, 0, -1, -1, 0, 1, 2, 2, 1, 0]
/** Heard from the cabin (critique §4.3: 82–83 % of the energy under 200 Hz, the highs muffled), about as loud overall. */
const CABIN = [-4, 2, 4, -4, -11, -16, -21, -27, -35, -43]

/** TUNED: the output scale at which the reference crash (a Panda into masonry at 15 m/s) peaks near the nominal 0.5. */
const SCALE = 0.112
/** No render peaks over this (a +6 dB crash with an unlucky draw is scaled down to it): the audition page's clipping mark. */
const LIMIT = 0.95

/** One body's crunch: its spectrum, its drive through the crush pulse, the main block and the sub-hits, its major buckles. Returns the spectrum (power, summing to 1). */
const crunch = (mix: Mix, hit: Hit, body: Crushed): Spectrum => {
  const { random, noise } = mix, { rate } = noise, spec = body.spec, crumples = ramp(2.5, 6, body.speed), target = hit.material === undefined ? undefined : TARGETS[hit.material]
  // A random tilt per render (the recordings spread 3–19 dB over 125 Hz–2 kHz; their median is flat).
  const tilt = between(random, -1.3, 1.3), db = CRUNCH.map((level, b) => {
    const rub = RUB[b]!, slope = b >= 2 && b <= 7 ? tilt * Math.log2(BANDS[b]! / 500) : 0
    return rub + (level - rub) * crumples + spec.colour[b]! + (body.zone === "side" ? SIDE[b]! : 0) + (target?.tint[b] ?? 0) + slope + between(random, -1, 1)
  })
  db[1]! += between(random, -3, 1)
  db[8]! += between(random, -3, 3)
  db[9]! += between(random, -4, 4)
  // The frame sweetener: from 12 m/s (the truck from 10) the lowest bands swell 2–5 dB, never the loudest.
  const sweet = between(random, 2, 5) * ramp(body.model === "truck" ? 10 : 12, body.model === "truck" ? 12 : 14, hit.equivalent)
  db[0]! += sweet
  db[1]! += sweet
  const raw = power(db), sum = raw.reduce((p, q) => p + q, 0), shape = raw.map((p) => p / sum)
  const eta = between(random, spec.field[0], spec.field[1]), t60 = BANDS.map((hz) => Math.min(0.8, 2.2 / (hz * eta)))

  const drive = new Float32Array(noise.power[0]!.length), { pulse, rise, block } = hit
  for (let c = 0; c < Math.min(drive.length, (1.3 * block + 0.01) * rate); c++) {
    const t = c / rate, r = t < rise ? 0.5 - 0.5 * Math.cos((Math.PI * t) / rise) : 1
    const crush = t < pulse / 2 ? Math.cos((Math.PI * t) / pulse) : 0
    const hold = t < 0.7 * block ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, (t - 0.7 * block) / (0.6 * block)))
    // A bump (no crumple) is the cover rubbing, a little quieter for its energy than a crunch.
    drive[c] = r * r * (0.55 * crush * crumples + 0.7 * hold) * (0.75 + 0.25 * crumples)
  }
  for (const sub of hit.subHits) {
    const up = between(random, 0.004, 0.01)
    for (let c = Math.round(sub.at * rate); c < Math.min(drive.length, (sub.at + up + sub.length) * rate); c++) {
      const t = c / rate - sub.at
      drive[c]! += 0.6 * sub.level * (t < up ? t / up : 0.5 + 0.5 * Math.cos((Math.PI * (t - up)) / sub.length))
    }
  }
  // Overlapping buckle grains, 1500–3000 a second, 2–5 ms each: Gaussian at 20 ms, a crackle underneath.
  const per = between(random, 1500, 3000) / rate, fall = Math.exp(-1 / (between(random, 0.002, 0.005) * rate)), mean = per / (1 - fall)
  for (let c = 0, level = mean; c < drive.length; c++) {
    if (drive[c] === 0) continue
    level = level * fall + (random() < per ? -Math.log(1 - random()) : 0)
    drive[c]! *= 0.6 + (0.4 * level) / mean
  }
  excite(noise, drive, shape.map((p) => p * body.part), t60)

  // The major buckles: 3–30, energies p(E) ∝ E^−α (α 1.3–1.6) over 20 dB, mostly inside the pulse (rate ∝ cos(πt/T)), the rest through the block and the sub-hits.
  const snap = tint(shape, SNAP), alpha = between(random, 1.3, 1.6), top = 10 ** between(random, 0.3, 0.8)
  for (let i = Math.round(crumples * Math.min(30, 3 + 1.1 * body.speed)); i > 0; i--) {
    const u = random(), sub = hit.subHits[Math.floor(random() * hit.subHits.length)]
    const t = u < 0.6 ? rise + 0.005 + (pulse / Math.PI) * Math.asin(random()) : u < 0.85 || sub === undefined ? between(random, pulse / 2, 0.9 * block) : sub.at + 0.3 * sub.length * random()
    // The contact stays the loudest moment of its first 50 ms.
    const peak = top * (t < 0.05 ? 0.08 : 0.9) * body.part * powerLaw(random(), alpha, 0.01, 1), tau = between(random, 0.0002, 0.0008)
    puff(mix, t, 0.0003, between(random, 0.001, 0.004), peak, snap)
    for (let m = Math.round(between(random, 4, 8)); m > 0; m--) {
      const hz = between(random, spec.panels[0], spec.panels[1])
      strike(mix, t, hz, spec.panelEta * between(random, 0.6, 1.4), 0.08 * Math.sqrt(peak) * rayleigh(random) * halfSine(hz, tau))
    }
  }
  return shape
}

/** 1–3 stiff parts ringing through the crunch (critique §4.4): 0.6–4.3 kHz, T60 0.2–0.9 s (η 0.001–0.01), 9–18 dB clear of it in a narrow band. */
const partials = (mix: Mix, hit: Hit, body: Crushed, shape: Spectrum, count: number): void => {
  const { random } = mix, { hz: [lo, hi], t60 } = body.spec.partials
  for (let i = 0; i < count; i++) {
    const hz = lo * (hi / lo) ** random(), b = Math.round(Math.log2(hz / BANDS[0]!)), prominence = between(random, 20, 26)
    // A sine's power against the main block's in one 85 ms bin (≈ 25 Hz / f of its octave's); driven up with the contact.
    const bed = 0.7 * (0.75 + 0.25 * ramp(2.5, 6, body.speed)) * body.part * shape[b]!
    const amp = Math.sqrt(2 * 10 ** (prominence / 10) * bed * (25 / hz)), t = between(random, 0, 0.02)
    const loss = Math.min(0.01, Math.max(0.0008, 2.2 / (hz * between(random, t60[0], t60[1]))))
    strike(mix, t, hz, loss, amp, hit.rise)
    const again = hit.subHits[0]
    if (again !== undefined && random() < 0.5) strike(mix, again.at, hz, loss, amp * 0.5)
  }
}

/** The first contact: the loudest moment of the first 50 ms, building over the contact's rise; half its power as bright as the contact is short (−6 dB at 0.83/τ: a PP cover's 3–8 ms is dull, steel on stone bright). */
const contact = (mix: Mix, hit: Hit, shape: Spectrum): void => {
  const corner = 0.83 / hit.contact, coloured = shape.map((p, b) => p * (0.5 + 0.5 / (1 + (BANDS[b]! / corner) ** 2))), sum = coloured.reduce((p, q) => p + q, 0)
  puff(mix, 0, hit.rise, between(mix.random, 0.006, 0.012), between(mix.random, 0.8, 1.2), coloured.map((p) => p / sum))
}

/** From the cabin: its first air mode (1.2–1.5 × c/2L) booming with the hit and each sub-hit. */
const cabin = (mix: Mix, hit: Hit): void => {
  const { random } = mix, hz = (between(random, 1.2, 1.5) * 343) / (2 * hit.bodies[0]!.spec.cabin), eta = between(random, 0.06, 0.1)
  strike(mix, hit.rise / 2, hz, eta, 0.5)
  for (const sub of hit.subHits) strike(mix, sub.at, hz, eta, 0.5 * Math.sqrt(sub.level))
}

/** `out` × `scale`, trimmed after its last sample within 60 dB of its peak, faded over its last 0.15 s, never over `LIMIT`. */
const finish = (out: Float32Array, scale: number, sampleRate: number): Float32Array<ArrayBuffer> => {
  let peak = 0
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!))
  let end = out.length
  while (end > 1 && Math.abs(out[end - 1]!) < peak * 1e-3) end--
  end = Math.min(out.length, end + Math.round(0.02 * sampleRate))
  const fade = Math.min(Math.round(0.15 * sampleRate), end >> 2), k = peak * scale > LIMIT ? LIMIT / peak : scale, result = new Float32Array(end)
  for (let i = 0; i < end; i++) result[i] = out[i]! * k * (i < end - fade ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (i - end + fade)) / fade))
  return result
}

/** `sound` rendered at `sampleRate`, every choice drawn from `random` (deterministic for a seeded one). */
export const renderCrash = (sound: Crash, sampleRate: number, random: () => number): Float32Array<ArrayBuffer> => {
  const hit = hitOf(sound, random), gain = 10 ** (levelOf(sound) / 20), n = Math.ceil(hit.length * sampleRate)
  const mix: Mix = {
    out: new Float32Array(n), noise: noiseFor(n, sampleRate), sampleRate, random,
    // −80 dBFS at the output.
    floor: 1e-4 / (gain * SCALE), view: hit.inside ? power(CABIN) : BANDS.map(() => 1)
  }
  hit.bodies.forEach((body, i) => {
    const shape = crunch(mix, hit, body)
    if (i === 0) contact(mix, hit, shape)
    const [lo, hi] = body.spec.partials.count
    partials(mix, hit, body, shape, i === 0 ? Math.floor(between(random, lo, hi + 0.999)) : Math.floor(between(random, 0, 1.999)))
  })
  for (const body of hit.bodies) {
    breakage(mix, hit, body)
    aftermath(mix, hit, body)
  }
  if (hit.material !== undefined) TARGETS[hit.material].add(mix, hit)
  if (hit.inside) cabin(mix, hit)
  playNoise(mix.out, mix.noise, random, mix.floor)
  return finish(mix.out, gain * SCALE, sampleRate)
}
