/**
 * Decoders for the packed sections of `monzone.json` (encoders: `src/tools/pack.ts`). Large numeric
 * arrays travel as base64 of little-endian 16-bit integers: the heightmap as decimetres with each
 * row delta-coded from its first node, walls and trees as decimetres from `packOrigin` (100 m
 * south-west of the map's corner: bounds walls stick out a little). Decoding is exact: every value is an integer number of decimetres divided by 10, the
 * same double JSON would give for a one-decimal number.
 *
 * @module map/packed
 */

/** Where packed coordinates count from, decimetres: 100 m south-west of the bounds' corner. */
export const packOrigin = (bounds: { readonly minX: number; readonly minY: number }): { readonly x: number; readonly y: number } =>
  ({ x: Math.round(bounds.minX * 10) - 1000, y: Math.round(bounds.minY * 10) - 1000 })

/** The 16-bit words of a base64 string (little-endian). */
const words = (b64: string): Uint16Array => {
  const bin = atob(b64)
  const out = new Uint16Array(bin.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)
  return out
}

/** Heightmap nodes in decimetres from rows of `cols` int16 deltas (each row starts absolute). */
export const unpackRows = (b64: string, cols: number): Int16Array => {
  const deltas = new Int16Array(words(b64).buffer)
  const out = new Int16Array(deltas.length)
  for (let k = 0; k < out.length; k++) out[k] = k % cols === 0 ? deltas[k]! : out[k - 1]! + deltas[k]!
  return out
}

/**
 * Metres from uint16 values in groups of `stride`: the first `coords` are coordinates (x, y
 * alternating) in decimetres from `packOrigin(bounds)`, the rest hundredths (a tree's scale).
 */
export const unpackPoints = (b64: string, bounds: { readonly minX: number; readonly minY: number }, stride: number, coords: number): Float64Array => {
  const w = words(b64), out = new Float64Array(w.length), o = packOrigin(bounds)
  for (let k = 0; k < w.length; k++) {
    const c = k % stride
    out[k] = c >= coords ? w[k]! / 100 : (w[k]! + (c % 2 === 0 ? o.x : o.y)) / 10
  }
  return out
}
