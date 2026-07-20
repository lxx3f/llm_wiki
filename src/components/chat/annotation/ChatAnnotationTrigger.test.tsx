// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { ChatAnnotationTrigger } from "./ChatAnnotationTrigger"

const mockCreate = vi.fn()

vi.mock("./useAnnotationActions", () => ({
  useAnnotationActions: () => ({ createAnnotation: mockCreate }),
}))

const message = {
  id: "m1",
  role: "assistant" as const,
  content: "Long answer with A1, A2.",
  conversationId: "c1",
  timestamp: 1,
}

describe("ChatAnnotationTrigger", () => {
  it("does not open menu on right-click with empty selection", () => {
    mockCreate.mockClear()
    window.getSelection()?.removeAllRanges()

    const { getByTestId } = render(
      <ChatAnnotationTrigger message={message}>
        <div data-testid="content">{message.content}</div>
      </ChatAnnotationTrigger>
    )

    fireEvent.contextMenu(getByTestId("content"))
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
