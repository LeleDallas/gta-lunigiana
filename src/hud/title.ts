/**
 * The title card (markup in index.html) as the loading screen: a bar and the name of the step
 * running while the map downloads and the game builds, an error with a retry if that fails, and
 * "Press any key" once the first frame is drawn. It imports nothing, so `boot.ts` can show it
 * before the game modules (and the map they read) load. Also holds the DOM lookup the HUD shares.
 *
 * @module hud/title
 */

/** The element with `id`; throws when index.html lacks it. */
export const element = (document: Document, id: string): HTMLElement => {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`index.html lacks #${id}`)
  return found
}

/**
 * Resolves after the browser has had a chance to paint the card (and to deliver input queued
 * behind the last step): the next animation frame, or 100 ms in a background tab where frames stop.
 */
export const paint = (): Promise<void> =>
  new Promise((done) => {
    requestAnimationFrame(() => setTimeout(done))
    setTimeout(done, 100)
  })

const set = (node: HTMLElement, text: string) => {
  if (node.textContent !== text) node.textContent = text
}

/**
 * Names the running step (a live region: screen readers hear each new step) and moves the bar to
 * `done` (0..1). `detail` (bytes so far) sits outside the live region, so per-chunk updates stay quiet.
 */
export const loading = (document: Document, step: string, done: number, detail = ""): void => {
  set(element(document, "title-step"), step)
  set(element(document, "title-detail"), detail)
  const bar = element(document, "title-bar") as HTMLProgressElement
  bar.value = done
}

/** `loading` a new step, then `paint`: call before each long piece of start-up work. */
export const step = async (document: Document, name: string, done: number): Promise<void> => {
  loading(document, name, done)
  await paint()
}

/** Keeps the failed step on the card, announces the error and offers a reload (a failed module import stays failed until one). */
export const loadFailed = (document: Document, error: unknown): void => {
  console.error("start-up failed", error)
  const message = element(document, "title-error"), retry = element(document, "title-retry")
  message.textContent = `Failed to start: ${error instanceof Error ? error.message : String(error)}`
  message.hidden = retry.hidden = false
  retry.addEventListener("click", () => document.location.reload(), { once: true })
  retry.focus()
}

/** Swaps the bar for "Press any key" and hides the card on the first key press or click after that. */
export const titleReady = (window: Window): void => {
  const document = window.document, title = element(document, "title")
  element(document, "title-load").hidden = true
  element(document, "title-go").hidden = false
  const dismiss = () => {
    title.hidden = true
    window.removeEventListener("keydown", dismiss)
    window.removeEventListener("pointerdown", dismiss)
  }
  window.addEventListener("keydown", dismiss)
  window.addEventListener("pointerdown", dismiss)
}
