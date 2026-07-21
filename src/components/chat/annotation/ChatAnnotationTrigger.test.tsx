// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { ChatAnnotationTrigger } from "./ChatAnnotationTrigger"

const mockAsk = vi.fn()

vi.mock("./useAnnotationActions", () => ({
  useAnnotationActions: () => ({ askAnnotationQuestion: mockAsk }),
}))

const message = {
  id: "m1",
  role: "assistant" as const,
  content: "Long answer with A1, A2.",
  conversationId: "c1",
  timestamp: 1,
}

/**
 * Build a real DOM selection inside the rendered container so the
 * component's `getSelectionWithin` helper sees a non-empty range.
 * Takes the inner span that holds the text (rather than the outer
 * content div), so callers don't need to thread a separate query.
 */
function selectWithin(textSpan: HTMLElement) {
  const textNode = textSpan.firstChild
  if (!textNode) throw new Error("test fixture missing inner text node")
  const range = document.createRange()
  // Select the first character; that gives us a non-collapsed range
  // anchored inside the target.
  range.setStart(textNode, 0)
  range.setEnd(textNode, 1)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

describe("ChatAnnotationTrigger", () => {
  afterEach(() => {
    cleanup()
    mockAsk.mockReset()
    window.getSelection()?.removeAllRanges()
  })

  it("does not open menu on right-click with empty selection", () => {
    window.getSelection()?.removeAllRanges()
    const { getByTestId } = render(
      <ChatAnnotationTrigger message={message}>
        <div data-testid="content"><span data-testid="text-target">{message.content}</span></div>
      </ChatAnnotationTrigger>
    )
    fireEvent.contextMenu(getByTestId("content"))
    expect(mockAsk).not.toHaveBeenCalled()
  })

  it("right-click with a non-empty selection opens the popover (not askAnnotationQuestion)", () => {
    const { getByTestId, getByText, getByRole } = render(
      <ChatAnnotationTrigger message={message}>
        <div data-testid="content"><span data-testid="text-target">{message.content}</span></div>
      </ChatAnnotationTrigger>
    )
    selectWithin(getByTestId("text-target"))
    fireEvent.contextMenu(getByTestId("content"))
    // Click the "Ask separately about this" menu item to open the popover.
    fireEvent.click(getByRole("menuitem"))
    // The popover should now render — snippet text and textarea.
    expect(getByText(/Long answer with A1, A2\./)).toBeTruthy()
    expect(getByRole("textbox")).toBeTruthy()
    expect(mockAsk).not.toHaveBeenCalled()
  })

  it("submitting the popover calls askAnnotationQuestion with the snippet and range", () => {
    const { getByTestId, getByRole } = render(
      <ChatAnnotationTrigger message={message}>
        <div data-testid="content"><span data-testid="text-target">{message.content}</span></div>
      </ChatAnnotationTrigger>
    )
    selectWithin(getByTestId("text-target"))
    fireEvent.contextMenu(getByTestId("content"))
    fireEvent.click(getByRole("menuitem"))
    const ta = getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "explain this please" } })
    fireEvent.keyDown(ta, { key: "Enter" })
    expect(mockAsk).toHaveBeenCalledTimes(1)
    expect(mockAsk).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessageId: "m1",
        snippet: "L",
        question: "explain this please",
      }),
    )
  })
})
