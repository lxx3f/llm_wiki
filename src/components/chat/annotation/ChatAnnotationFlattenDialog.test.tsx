// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, fireEvent, screen } from "@testing-library/react"
import { ChatAnnotationFlattenDialog } from "./ChatAnnotationFlattenDialog"

const annotation = {
  id: "ann_1",
  parentMessageId: "m1",
  snippet: "x",
  status: "open" as const,
  createdAt: 1,
  thread: [
    { id: "t1", role: "user" as const, content: "Q?", conversationId: "c1", timestamp: 2 },
    { id: "t2", role: "assistant" as const, content: "A.", conversationId: "c1", timestamp: 3 },
  ],
}

describe("ChatAnnotationFlattenDialog", () => {
  // Explicit `cleanup` between tests — the project has no global
  // testing-library setup and `@testing-library/react` v16 no
  // longer auto-cleans.
  afterEach(() => {
    cleanup()
  })

  it("calls onConfirm when the confirm button is clicked", () => {
    const onConfirm = vi.fn()
    render(
      <ChatAnnotationFlattenDialog
        annotation={annotation}
        open
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /确认/ }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("does not call onConfirm when the dialog is closed without confirm", () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <ChatAnnotationFlattenDialog
        annotation={annotation}
        open
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /取消/ }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
