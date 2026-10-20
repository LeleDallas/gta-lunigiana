/**
 * Decoders for the packed sections of `monzone.json` (encoders: `src/tools/pack.ts`). Large numeric
 * arrays travel as base64 of little-endian integers: the heightmap as int16 decimetres with each
 * row delta-coded from its first node, walls as uint32 decimetres from `packOrigin` (100 m
 * south-west of the map's corner: bounds walls stick out a little), trees as uint16 whole metres
 * from the same corner (they are planted on whole metres). Decoding is exact: every coordinate is
 * an integer number of decimetres divided by 10, the same double JSON would give for a
 * one-decimal number.
 *
 * @module map/packed
 */

type Corner = { readonly minX: number; readonly minY: number }

/** Where wall coordinates count from, decimetres: 100 m south-west of the bounds' corner. */
export const packOrigin = (bounds: Corner): { readonly x: number; readonly y: number } =>
  ({ x: Math.round(bounds.minX * 10) - 1000, y: Math.round(bounds.minY * 10) - 1000 })

/** Where tree coordinates count from, whole metres: `packOrigin` rounded down to the metre. */
export const treeOrigin = (bounds: Corner): { readonly x: number; readonly y: number } => {
  const o = packOrigin(bounds)
  return { x: Math.floor(o.x / 10), y: Math.floor(o.y / 10) }
}

/** The bytes of a base64 string. */
const bytes = (b64: string): Uint8Array => {
  const bin = atob(b64), out = new Uint8Array(bin.length)
  for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Heightmap nodes in decimetres from rows of `cols` int16 deltas (each row starts absolute). */
export const unpackRows = (b64: string, cols: number): Int16Array => {
  const deltas = new Int16Array(bytes(b64).buffer)
  const out = new Int16Array(deltas.length)
  for (let k = 0; k < out.length; k++) out[k] = k % cols === 0 ? deltas[k]! : out[k - 1]! + deltas[k]!
  return out
}

/** Wall segments (ax, ay, bx, by) in metres from uint32 decimetres from `packOrigin(bounds)`. */
export const unpackWalls = (b64: string, bounds: Corner): Float64Array => {
  const w = new Uint32Array(bytes(b64).buffer), out = new Float64Array(w.length), o = packOrigin(bounds)
  for (let k = 0; k < w.length; k++) out[k] = (w[k]! + (k % 2 === 0 ? o.x : o.y)) / 10
  return out
}

/** Trees (x, y, scale): uint16 whole metres from `treeOrigin(bounds)`, the scale in hundredths. */
export const unpackTrees = (b64: string, bounds: Corner): Float64Array => {
  const w = new Uint16Array(bytes(b64).buffer), out = new Float64Array(w.length), o = treeOrigin(bounds)
  for (let k = 0; k < w.length; k++) {
    const c = k % 3
    out[k] = c === 2 ? w[k]! / 100 : w[k]! + (c === 0 ? o.x : o.y)
  }
  return out
}
