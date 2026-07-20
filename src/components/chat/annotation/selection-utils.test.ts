// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { getSelectionWithin, isCollapsedOrEmpty } from "./selection-utils"

describe("getSelectionWithin", () => {
  it("returns null when no selection", () => {
    document.body.innerHTML = '<div id="r">Hello world</div>'
    const root = document.getElementById("r")!
    window.getSelection()?.removeAllRanges()
    expect(getSelectionWithin(root)).toBeNull()
  })

  it("returns snippet and range when selection inside root", () => {
    document.body.innerHTML = '<div id="r">Hello world</div>'
    const root = document.getElementById("r")!
    const range = document.createRange()
    range.setStart(root.firstChild!, 6)
    range.setEnd(root.firstChild!, 11)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    const result = getSelectionWithin(root)
    expect(result?.snippet).toBe("world")
    expect(result?.range).toEqual({ start: 6, end: 11 })
  })

  it("returns null when selection starts outside root", () => {
    document.body.innerHTML = '<span id="a">aaa</span><div id="r">bbb</div>'
    const a = document.getElementById("a")!
    const r = document.getElementById("r")!
    const range = document.createRange()
    range.setStart(a.firstChild!, 0)
    range.setEnd(r.firstChild!, 1)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(getSelectionWithin(r)).toBeNull()
  })

  it("handles UTF-16 surrogate pair (emoji) correctly", () => {
    document.body.innerHTML = '<div id="r">A😀B</div>'
    const root = document.getElementById("r")!
    const text = root.firstChild!
    const range = document.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 3) // 😀 is 2 UTF-16 code units
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    const result = getSelectionWithin(root)
    expect(result?.snippet).toBe("😀")
    expect(result?.range).toEqual({ start: 1, end: 3 })
  })
})

describe("isCollapsedOrEmpty", () => {
  function makeCollapsedSelection(): Selection {
    document.body.innerHTML = '<div id="r">Hello world</div>'
    const root = document.getElementById("r")!
    const range = document.createRange()
    range.setStart(root.firstChild!, 3)
    range.collapse(true) // collapsed at a single point
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    return sel
  }

  it("returns true for null and for a collapsed selection", () => {
    expect(isCollapsedOrEmpty(null)).toBe(true)
    expect(isCollapsedOrEmpty(makeCollapsedSelection())).toBe(true)
  })
})
