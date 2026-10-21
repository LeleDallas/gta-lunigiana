import assert from "node:assert/strict"
import { test } from "node:test"

import { titleReady } from "./title.ts"

/** The title card's elements as plain objects, in a window whose events tests dispatch. */
const page = () => {
  const nodes = new Map(["title", "title-load", "title-go"].map((id) => [id, { hidden: id === "title-go" }]))
  const window = Object.assign(new EventTarget(), { document: { getElementById: (id: string) => nodes.get(id) ?? null } })
  return { window: window as unknown as Window, node: (id: string) => nodes.get(id)! }
}

// Regression: the card said "Press any key" while the game was still downloading, and keys did nothing.
test("the card waits for the game: keys do nothing until ready, then the first one hides it", () => {
  const { window, node } = page()
  window.dispatchEvent(new Event("keydown"))
  assert.equal(node("title").hidden, false, "a key while loading leaves the card up")
  titleReady(window)
  assert.equal(node("title-load").hidden, true)
  assert.equal(node("title-go").hidden, false, "ready: the bar gives way to Press any key")
  window.dispatchEvent(new Event("keydown"))
  assert.equal(node("title").hidden, true)
})
