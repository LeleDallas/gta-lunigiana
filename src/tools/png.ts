// Minimal PNG codec on node:zlib. Decoder ported from .research/scratch-osm-monzone/lib.ts
// (8-bit RGB as the terrarium tiles are, non-interlaced, filters 0-4; verified against sips).
import { crc32, deflateSync, inflateSync } from "node:zlib"

interface Png { readonly width: number; readonly height: number; readonly data: Uint8Array }

const SIG = [137, 80, 78, 71, 13, 10, 26, 10]

export const decodePng = (buf: Uint8Array): Png => {
  if (!SIG.every((v, i) => buf[i] === v)) throw new Error(`not a PNG: ${Buffer.from(buf.subarray(0, 16)).toString("latin1")}`)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let p = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat: Array<Uint8Array> = []
  while (p < buf.length) {
    const len = dv.getUint32(p)
    const type = String.fromCharCode(...buf.subarray(p + 4, p + 8))
    const chunk = buf.subarray(p + 8, p + 8 + len)
    if (type === "IHDR") {
      width = dv.getUint32(p + 8)
      height = dv.getUint32(p + 12)
      bitDepth = chunk[8]!
      colorType = chunk[9]!
      interlace = chunk[12]!
    } else if (type === "IDAT") idat.push(chunk)
    else if (type === "IEND") break
    p += 12 + len
  }
  const channels = 3
  if (bitDepth !== 8 || interlace !== 0 || colorType !== 2) throw new Error(`unsupported PNG bitDepth=${bitDepth} interlace=${interlace} colorType=${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const r = raw[src + x]!
      const a = x >= channels ? out[dst + x - channels]! : 0
      const b = y > 0 ? out[dst - stride + x]! : 0
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels]! : 0
      let v: number
      if (f === 0) v = r
      else if (f === 1) v = r + a
      else if (f === 2) v = r + b
      else if (f === 3) v = r + ((a + b) >> 1)
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      } else throw new Error(`bad PNG filter ${f} at row ${y}`)
      out[dst + x] = v & 255
    }
  }
  return { width, height, data: out }
}

const chunk = (type: string, data: Uint8Array): Buffer => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "latin1")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** Encodes 8-bit RGB pixels (row-major, top row first) as a PNG with filter 0. */
export const encodePngRgb = (width: number, height: number, rgb: Uint8Array): Buffer => {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from(SIG), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))])
}
