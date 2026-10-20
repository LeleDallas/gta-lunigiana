/**
 * The HUD: plain DOM over the canvas (markup in index.html). It reads only the PlayerView model
 * and the map, and touches the DOM only when a text changes.
 *
 * @module hud
 */
import type { PlayerViewModel } from "../sim/index.ts"
import { locationAt } from "./location.ts"
import { makeMinimap } from "./minimap.ts"

/** The action prompt for the current view, or "" when there is nothing to do. */
export const promptText = (view: PlayerViewModel): string => {
  if (view.mode === "driving") return "F — exit"
  if (view.mode === "down" || view.nearby === undefined) return ""
  const { occupied, stolen, label } = view.nearby
  return occupied ? `F — carjack ${label}` : stolen ? `F — enter ${label}` : `F — steal ${label}`
}

/** Speedometer reading in km/h (always positive, rounded). */
export const kmh = (metresPerSecond: number): number => Math.round(Math.abs(metresPerSecond) * 3.6)

const element = (document: Document, id: string): HTMLElement => {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`index.html lacks #${id}`)
  return found
}

/** Binds the HUD to its markup; `update` once per frame with the interpolated player position. */
export const makeHud = (document: Document) => {
  const road = element(document, "hud-road"), district = element(document, "hud-district")
  const stolen = element(document, "hud-stolen"), knocked = element(document, "hud-knocked")
  const speedo = element(document, "hud-speedo"), speed = element(document, "hud-speed"), vehicle = element(document, "hud-vehicle")
  const prompt = element(document, "hud-prompt")
  const minimap = makeMinimap(document)
  element(document, "hud-minimap").append(minimap.canvas)
  const set = (node: HTMLElement, text: string) => {
    if (node.textContent !== text) node.textContent = text
  }
  const show = (node: HTMLElement, visible: boolean) => {
    if (node.hidden === visible) node.hidden = !visible
  }
  let located = { x: Number.NaN, y: Number.NaN }
  return {
    update: (view: PlayerViewModel, x: number, y: number, angle: number): void => {
      // Names change slowly: look them up again only after moving a couple of metres.
      if (!(Math.hypot(x - located.x, y - located.y) < 2)) {
        located = { x, y }
        const here = locationAt(x, y)
        set(road, here.road ?? "")
        set(district, here.district)
      }
      set(stolen, String(view.score.stolen))
      set(knocked, String(view.score.knocked))
      show(speedo, view.vehicle !== undefined)
      if (view.vehicle !== undefined) {
        set(speed, String(kmh(view.vehicle.speed)))
        set(vehicle, view.vehicle.label)
      }
      const text = promptText(view)
      show(prompt, text !== "")
      set(prompt, text)
      minimap.draw(x, y, angle)
    }
  }
}

/** Hides the title card on the first key press or click. */
export const dismissTitleOnInput = (window: Window): void => {
  const title = window.document.getElementById("title")
  if (title === null) return
  const dismiss = () => {
    title.hidden = true
    window.removeEventListener("keydown", dismiss)
    window.removeEventListener("pointerdown", dismiss)
  }
  window.addEventListener("keydown", dismiss)
  window.addEventListener("pointerdown", dismiss)
}
