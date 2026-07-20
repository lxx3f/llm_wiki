// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, fireEvent } from "@testing-library/react"
import { PerParagraphTrigger } from "./PerParagraphTrigger"

const mockCreate = vi.fn()

vi.mock("./useAnnotationActions", () => ({
  useAnnotationActions: () => ({ createAnnotation: mockCreate }),
}))

describe("PerParagraphTrigger", () => {
  afterEach(() => {
    cleanup()
  })

  it("calls createAnnotation on click with the right args", () => {
    mockCreate.mockClear()
    const { getByLabelText } = render(
      <PerParagraphTrigger paragraph="A1 is..." parentMessageId="m1" />
    )
    fireEvent.click(getByLabelText("针对此段追问"))
    expect(mockCreate).toHaveBeenCalledWith({
      parentMessageId: "m1",
      snippet: "A1 is...",
      range: undefined,
    })
  })

  it("button is hidden until hover via Tailwind group-hover classes", () => {
    const { getByLabelText } = render(
      <PerParagraphTrigger paragraph="A1" parentMessageId="m1" />
    )
    const btn = getByLabelText("针对此段追问")
    // `@testing-library/jest-dom` is not installed in this project;
    // assert classes via the DOM API directly.
    expect(btn.classList.contains("opacity-0")).toBe(true)
    expect(btn.classList.contains("group-hover:opacity-100")).toBe(true)
    expect(btn.classList.contains("transition-opacity")).toBe(true)
  })
})