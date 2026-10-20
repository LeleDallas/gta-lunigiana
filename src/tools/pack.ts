// Encoders for the packed sections of monzone.json; the format and the decoders are in
// src/sim/map/packed.ts. Every value must fit its integer type, or the build throws.
import { packOrigin, treeOrigin } from "../sim/map/packed.ts"

type Corner = { readonly minX: number; readonly minY: number }

const RANGE = { int16: [-32768, 32767], uint16: [0, 65535], uint32: [0, 2 ** 32 - 1] } as const

/** Little-endian base64 of `values`, each checked against `type`. */
const base64 = (values: ArrayLike<number>, type: keyof typeof RANGE, what: string): string => {
  const [lo, hi] = RANGE[type], size = type === "uint32" ? 4 : 2
  const buf = Buffer.alloc(values.length * size)
  for (let k = 0; k < values.length; k++) {
    const v = values[k]!
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what}: ${v} at ${k} does not fit ${type}`)
    if (type === "int16") buf.writeInt16LE(v, 2 * k)
    else if (type === "uint16") buf.writeUInt16LE(v, 2 * k)
    else buf.writeUInt32LE(v, 4 * k)
  }
  return buf.toString("base64")
}

/** Integer decimetres, rows of `cols` values each delta-coded from its first. */
export const packRows = (dm: ArrayLike<number>, cols: number): string =>
  base64(Array.from(dm, (v, k) => (k % cols === 0 ? v : v - dm[k - 1]!)), "int16", "heightmap")

/** Wall segments (ax, ay, bx, by) as decimetres from `packOrigin(bounds)`. */
export const packWalls = (flat: ArrayLike<number>, bounds: Corner, what: string): string => {
  const o = packOrigin(bounds)
  return base64(Array.from(flat, (v, k) => Math.round(v * 10) - (k % 2 === 0 ? o.x : o.y)), "uint32", what)
}

/** Trees (x, y, scale) on whole metres: metres from `treeOrigin(bounds)`, the scale in hundredths. */
export const packTrees = (flat: ArrayLike<number>, bounds: Corner): string => {
  const o = treeOrigin(bounds)
  return base64(Array.from(flat, (v, k) => {
    const c = k % 3
    return c === 2 ? Math.round(v * 100) : v - (c === 0 ? o.x : o.y)
  }), "uint16", "trees")
}
