// Encoders for the packed sections of monzone.json; the format and the decoders are in
// src/sim/map/packed.ts. Every value must fit its 16-bit range, or the build throws.
import { packOrigin } from "../sim/map/packed.ts"

const base64 = (values: ArrayLike<number>, signed: boolean, what: string): string => {
  const buf = Buffer.alloc(values.length * 2)
  for (let k = 0; k < values.length; k++) {
    const v = values[k]!
    if (!Number.isInteger(v) || (signed ? v < -32768 || v > 32767 : v < 0 || v > 65535)) throw new Error(`${what}: ${v} at ${k} does not fit 16 bits`)
    if (signed) buf.writeInt16LE(v, 2 * k)
    else buf.writeUInt16LE(v, 2 * k)
  }
  return buf.toString("base64")
}

/** Integer decimetres, rows of `cols` values each delta-coded from its first. */
export const packRows = (dm: ArrayLike<number>, cols: number): string =>
  base64(Array.from(dm, (v, k) => (k % cols === 0 ? v : v - dm[k - 1]!)), true, "heightmap")

/** Groups of `stride` values: `coords` coordinates (x, y alternating) as decimetres from `packOrigin(bounds)`, the rest in hundredths. */
export const packPoints = (flat: ArrayLike<number>, bounds: { readonly minX: number; readonly minY: number }, stride: number, coords: number, what: string): string => {
  const o = packOrigin(bounds)
  return base64(Array.from(flat, (v, k) => {
    const c = k % stride
    return c >= coords ? Math.round(v * 100) : Math.round(v * 10) - (c % 2 === 0 ? o.x : o.y)
  }), false, what)
}
