/**
 * Every vehicle sound kind and its synth: the speaker's `Voices` and `Shots` tables spread these in
 * beside the world's, so a vehicle kind without a synth fails to compile.
 *
 * @module audio/synth/vehicles
 */
import type { Shots, Voices } from "../types.ts"
import { engine } from "./engine.ts"
import { beeper, honk, horn, siren } from "./horns.ts"
import { crash, door, ignition, scrape, thud } from "./impacts.ts"
import { tyres } from "./tyres.ts"

/** Continuous vehicle sounds. */
export const VEHICLE_VOICES = { engine, tyres, scrape, horn, siren, beeper } satisfies Pick<Voices, "engine" | "tyres" | "scrape" | "horn" | "siren" | "beeper">

/** One-shot vehicle sounds. */
export const VEHICLE_SHOTS = { crash, thud, door, ignition, honk } satisfies Pick<Shots, "crash" | "thud" | "door" | "ignition" | "honk">
