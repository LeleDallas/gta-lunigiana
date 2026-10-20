/**
 * The closed set of vehicle models and their handling. Render code keeps its
 * own `satisfies Record<VehicleModel, ...>` mesh table, so a new model fails to
 * compile until it has both stats and a mesh.
 */
export const VEHICLE_MODELS = ["panda", "ape", "truck", "carabinieri"] as const
export type VehicleModel = (typeof VEHICLE_MODELS)[number]

export interface VehicleSpec {
  readonly label: string
  /** Body length and width in metres (collision is a row of circles along the length). */
  readonly length: number
  readonly width: number
  /** Top forward speed and reverse speed in m/s. */
  readonly maxSpeed: number
  readonly reverseSpeed: number
  /** Throttle and brake acceleration in m/s². */
  readonly accel: number
  readonly brake: number
  /** Yaw rate at full lock and speed, rad/s. */
  readonly turn: number
  /** Lateral grip in 1/s: how fast sideways slip dies out (handbrake lowers it). */
  readonly grip: number
  /** Relative mass for car-to-car pushes. */
  readonly mass: number
}

export const VEHICLES = {
  panda: { label: "Fiat Panda", length: 3.7, width: 1.65, maxSpeed: 28, reverseSpeed: 7, accel: 7, brake: 14, turn: 2.4, grip: 9, mass: 1 },
  ape: { label: "Piaggio Ape", length: 2.9, width: 1.4, maxSpeed: 15, reverseSpeed: 4, accel: 4, brake: 10, turn: 2.8, grip: 7, mass: 0.6 },
  truck: { label: "Camion del marmo", length: 7.6, width: 2.45, maxSpeed: 20, reverseSpeed: 4, accel: 3, brake: 8, turn: 1.3, grip: 10, mass: 4 },
  carabinieri: { label: "Alfa Romeo Giulia dei Carabinieri", length: 4.6, width: 1.85, maxSpeed: 42, reverseSpeed: 9, accel: 11, brake: 18, turn: 2.2, grip: 11, mass: 1.3 }
} as const satisfies Record<VehicleModel, VehicleSpec>

/** Civilian paint colours (sRGB hex), picked with the world's Rng. */
export const CAR_COLORS = [0xb8312b, 0xf2efe6, 0x3d6155, 0x1d2b4f, 0xd4a85e, 0x74746f, 0x4a3222, 0x8db4b0] as const
