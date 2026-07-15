import { describe, expect, it, vi } from "vitest"

vi.mock("./chat-message", () => ({
  ChatMessage: () => null,
  StreamingMessage: () => null,
  useSourceFiles: () => undefined,
}))
vi.mock("@/components/editor/file-preview", () => ({ FilePreview: () => null }))
vi.mock("@/components/editor/wiki-reader", () => ({ WikiReader: () => null }))
vi.mock("@/components/editor/frontmatter-panel", () => ({ FrontmatterPanel: () => null }))

import { ChatSessionContent, WikiWriteConfirmationCard } from "./chat-session-content"

const pending = {
  id: "pending-1",
  path: "wiki/page.md",
  content: "# Updated page",
  existedBefore: true,
}

describe("ChatSessionContent", () => {
  it("exports an embeddable session-content component", () => {
    expect(ChatSessionContent).toBeTypeOf("function")
  })

  it("does not call confirmation before the confirmation-card button is clicked", () => {
    const onConfirm = vi.fn()
    const card = WikiWriteConfirmationCard({ pendingWrite: pending, onConfirm, onCancel: vi.fn() }) as {
      props: { children: unknown[] }
    }
    const actions = card.props.children[3] as { props: { children: Array<{ props: { onClick: () => void } }> } }

    expect(onConfirm).not.toHaveBeenCalled()
    actions.props.children[0].props.onClick()
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onConfirm).toHaveBeenCalledWith(pending.id)
  })

  it("calls the cancellation callback without confirmation IPC", () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const card = WikiWriteConfirmationCard({ pendingWrite: pending, onConfirm, onCancel }) as {
      props: { children: unknown[] }
    }
    const actions = card.props.children[3] as { props: { children: Array<{ props: { onClick: () => void } }> } }

    actions.props.children[1].props.onClick()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
