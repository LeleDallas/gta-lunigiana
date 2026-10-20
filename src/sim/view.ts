/**
 * Ground directions of the screen axes for the fixed isometric camera, which
 * sits north-west of the focus and looks south-east (the mountains rise to the
 * south and east, so this side sees every street). Render builds the camera
 * from these; the sim maps on-foot input through them.
 */
export const SCREEN_UP = { x: Math.SQRT1_2, y: -Math.SQRT1_2 } as const
export const SCREEN_RIGHT = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 } as const

/** The camera leads the player by this many seconds of their velocity, at most `max` metres. */
export const LOOK_AHEAD = { seconds: 0.6, max: 14 } as const

/**
 * Farthest ground the camera shows from the player, m: half the diagonal of the widest view (16:9,
 * 270 texels tall at 5 texels/m from 30° up: 96 × 108 m, so 72 m) plus the full look-ahead, rounded
 * up. Populate spawns, and quietly removes bodies, only beyond it.
 */
// ponytail: sized for 16:9; ultrawide screens see ~15 m further. Cap PixelView's aspect if that pop-in shows.
export const VIEW_REACH = 90
