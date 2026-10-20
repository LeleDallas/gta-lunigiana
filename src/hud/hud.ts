/**
 * The HUD: plain DOM over the canvas (markup in index.html). It reads only the PlayerView model
 * and the map, and touches the DOM only when a text changes.
 *
 * @module hud
 */
import type { PlayerViewModel } from "../sim/index.ts"
import { locationAt } from "./location.ts"
import { makeMinimap } from "./minimap.ts"
import { makeWorldMap } from "./worldmap.ts"

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

/** Binds the HUD to its markup; `update` once per frame with the interpolated player position and the view's yaw. */
export const makeHud = (document: Document) => {
  const road = element(document, "hud-road"), district = element(document, "hud-district")
  const stolen = element(document, "hud-stolen"), knocked = element(document, "hud-knocked")
  const speedo = element(document, "hud-speedo"), speed = element(document, "hud-speed"), vehicle = element(document, "hud-vehicle")
  const prompt = element(document, "hud-prompt")
  const minimap = makeMinimap(document)
  element(document, "hud-minimap").append(minimap.canvas)
  const worldMap = makeWorldMap(document)
  let last = { x: Number.NaN, y: Number.NaN, angle: 0 }
  const set = (node: HTMLElement, text: string) => {
    if (node.textContent !== text) node.textContent = text
  }
  const show = (node: HTMLElement, visible: boolean) => {
    if (node.hidden === visible) node.hidden = !visible
  }
  let located = { x: Number.NaN, y: Number.NaN }
  return {
    /** Whether the full map is open (the host pauses the game while it is). */
    mapOpen: (): boolean => worldMap.open,
    /** Opens the full map at the last drawn player position, or closes it. */
    toggleMap: (): void => (worldMap.open ? worldMap.hide() : worldMap.show(last.x, last.y, last.angle)),
    closeMap: (): void => worldMap.hide(),
    /** Repaints the open map (after the pixel ratio changes without a resize). */
    repaintMap: (): void => {
      if (worldMap.open) worldMap.show(last.x, last.y, last.angle)
    },
    update: (view: PlayerViewModel, x: number, y: number, angle: number, yaw: number): void => {
      last = { x, y, angle }
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
      minimap.draw(x, y, angle, yaw)
    }
  }
}

/**
 * M toggles the full map; Esc closes it. Held-down repeats and modified keys (Cmd+M...) are
 * ignored. M is matched by the character it types, so it is the key labelled M on any Latin layout
 * (AZERTY too); layouts whose keys type no ASCII character (Cyrillic, Greek) fall back to its position.
 */
export const toggleMapOnKey = (window: Pick<Window, "addEventListener">, hud: { readonly toggleMap: () => void; readonly closeMap: () => void }): void => {
  window.addEventListener("keydown", (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key === "m" || (event.code === "KeyM" && !/^[ -~]$/.test(key))) hud.toggleMap()
    else if (event.code === "Escape") hud.closeMap()
  })
}

/**
 * The fixed-loop update with the full map able to pause the game: `tick` while it is closed;
 * while it is open, `skip`, after draining the keyboard's press edges so keys tapped on the map do
 * not act when play resumes (held keys stay held).
 */
export const pausable = <R>(paused: () => boolean, keyboard: { readonly snapshot: () => unknown }, tick: () => R, skip: R) => (): R => {
  if (!paused()) return tick()
  keyboard.snapshot()
  return skip
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
