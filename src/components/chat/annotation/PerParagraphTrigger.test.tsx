// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, fireEvent } from "@testing-library/react"
import { PerParagraphTrigger } from "./PerParagraphTrigger"

const mockAsk = vi.fn()

vi.mock("./useAnnotationActions", () => ({
  useAnnotationActions: () => ({ askAnnotationQuestion: mockAsk }),
}))

describe("PerParagraphTrigger", () => {
  afterEach(() => {
    cleanup()
    mockAsk.mockReset()
  })

  it("does NOT call askAnnotationQuestion on click — opens the popover first", () => {
    const { getByLabelText } = render(
      <PerParagraphTrigger paragraph="A1 is..." parentMessageId="m1" />
    )
    fireEvent.click(getByLabelText("针对此段追问"))
    expect(mockAsk).not.toHaveBeenCalled()
  })

  it("opens the popover with the paragraph as snippet on click", () => {
    const { getByLabelText, getByText, getByRole } = render(
      <PerParagraphTrigger paragraph="A1 is a paragraph" parentMessageId="m1" />
    )
    fireEvent.click(getByLabelText("针对此段追问"))
    // The snippet text appears in the popover.
    expect(getByText(/A1 is a paragraph/)).toBeTruthy()
    expect(getByRole("textbox")).toBeTruthy()
  })

  it("submitting a question calls askAnnotationQuestion with snippet + range", () => {
    const { getByLabelText, getByRole } = render(
      <PerParagraphTrigger paragraph="A1" parentMessageId="m1" />
    )
    fireEvent.click(getByLabelText("针对此段追问"))
    const ta = getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "what does A1 mean?" } })
    fireEvent.keyDown(ta, { key: "Enter" })
    expect(mockAsk).toHaveBeenCalledWith({
      parentMessageId: "m1",
      snippet: "A1",
      range: undefined,
      question: "what does A1 mean?",
    })
  })

  it("canceling the popover does NOT call askAnnotationQuestion", () => {
    const { getByLabelText, getByRole } = render(
      <PerParagraphTrigger paragraph="A1" parentMessageId="m1" />
    )
    fireEvent.click(getByLabelText("针对此段追问"))
    fireEvent.click(getByRole("button", { name: "取消" }))
    expect(mockAsk).not.toHaveBeenCalled()
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
