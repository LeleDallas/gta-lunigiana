/**
 * The minimap: the whole map drawn once (areas, water, rail, roads, buildings) into an offscreen
 * canvas, then blitted every frame around the player, rotated so that screen-up is minimap-up,
 * with the player as an arrow.
 *
 * @module hud/minimap
 */
import { type AreaKind, isAreaKind, MAP, roadClassOf } from "../sim/map/index.ts"
import { SCREEN_UP } from "../sim/view.ts"
import { roadHex } from "../render/lines.ts"
import { css, PALETTE } from "../render/palette.ts"

/** Base map pixels per metre. */
const BASE = 0.5
/** Metres across the minimap. */
const SPAN = 300

/** Area fills; kinds left out (grassland, residential) show the grass background. */
const AREA_HEX: Partial<Record<AreaKind, number>> = {
  forest: PALETTE.forest, cemetery: PALETTE.plasterGrey, pitch: PALETTE.forestLight, park: PALETTE.forestLight,
  parking: PALETTE.asphaltWorn, vineyard: PALETTE.grassDry, farmland: PALETTE.grassDry, farmyard: PALETTE.dirtTrack,
  industrial: PALETTE.stoneMid, platform: PALETTE.asphaltWorn, school: PALETTE.grass, ruins: PALETTE.stoneMid
}

/**
 * Canvas rotation that turns SCREEN_UP to minimap-up: the canvas is drawn north-up (v = −y), where
 * SCREEN_UP points at angle atan2(−up.y, up.x); rotating by −π/2 minus that brings it to the top.
 */
export const MINIMAP_ROTATION = -Math.PI / 2 - Math.atan2(-SCREEN_UP.y, SCREEN_UP.x)

const drawBase = (document: Document): HTMLCanvasElement => {
  const { minX, minY, maxX, maxY } = MAP.bounds
  const canvas = document.createElement("canvas")
  canvas.width = Math.ceil((maxX - minX) * BASE)
  canvas.height = Math.ceil((maxY - minY) * BASE)
  const ctx = canvas.getContext("2d")
  if (ctx === null) return canvas
  const u = (x: number) => (x - minX) * BASE, v = (y: number) => (maxY - y) * BASE
  const path = (flat: ReadonlyArray<number>, closed: boolean, into = new Path2D()) => {
    into.moveTo(u(flat[0]!), v(flat[1]!))
    for (let i = 2; i + 1 < flat.length; i += 2) into.lineTo(u(flat[i]!), v(flat[i + 1]!))
    if (closed) into.closePath()
    return into
  }
  ctx.fillStyle = css(PALETTE.grass)
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (const area of MAP.areas) {
    const hex = isAreaKind(area.kind) ? AREA_HEX[area.kind] : undefined
    if (hex === undefined) continue
    const p = new Path2D()
    for (const ring of area.rings) path(ring, true, p)
    ctx.fillStyle = css(hex)
    ctx.fill(p, "evenodd")
  }
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  const stroke = (flat: ReadonlyArray<number>, width: number, hex: number) => {
    ctx.strokeStyle = css(hex)
    ctx.lineWidth = Math.max(1, width * BASE)
    ctx.stroke(path(flat, false))
  }
  for (const w of MAP.water) stroke(w.pts, w.w, PALETTE.waterShallow)
  for (const r of MAP.rail) if (r.tunnel !== true) stroke(r.pts, 2, PALETTE.stoneDark)
  for (const road of MAP.roads) if (road.tunnel !== true && roadClassOf(road) !== "path") stroke(road.pts, road.w * 1.6, roadHex(road))
  ctx.fillStyle = css(PALETTE.roofTile)
  for (const b of MAP.buildings) ctx.fill(path(b.outer, true))
  return canvas
}

/** The minimap canvas (`size` px square, drawn at half resolution for chunky pixels) and its per-frame draw. */
export const makeMinimap = (document: Document, size = 180) => {
  const canvas = document.createElement("canvas")
  canvas.className = "minimap"
  canvas.width = canvas.height = size / 2
  canvas.style.width = canvas.style.height = `${size}px`
  const base = drawBase(document)
  const ctx = canvas.getContext("2d")
  const s = canvas.width, zoom = s / SPAN / BASE
  return {
    canvas,
    /** Draws the map around (x, y) with the player arrow pointing along `angle` (radians CCW from east). */
    draw: (x: number, y: number, angle: number): void => {
      if (ctx === null) return
      ctx.imageSmoothingEnabled = false
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = css(PALETTE.forestDark)
      ctx.fillRect(0, 0, s, s)
      ctx.setTransform(1, 0, 0, 1, s / 2, s / 2)
      ctx.rotate(MINIMAP_ROTATION)
      ctx.scale(zoom, zoom)
      ctx.drawImage(base, -(x - MAP.bounds.minX) * BASE, -(MAP.bounds.maxY - y) * BASE)
      ctx.setTransform(1, 0, 0, 1, s / 2, s / 2)
      ctx.rotate(MINIMAP_ROTATION - angle)
      ctx.beginPath()
      ctx.moveTo(5, 0)
      ctx.lineTo(-4, 3.5)
      ctx.lineTo(-2, 0)
      ctx.lineTo(-4, -3.5)
      ctx.closePath()
      ctx.fillStyle = css(PALETTE.signYellow)
      ctx.strokeStyle = css(PALETTE.outline)
      ctx.lineWidth = 1
      ctx.fill()
      ctx.stroke()
    }
  }
}
