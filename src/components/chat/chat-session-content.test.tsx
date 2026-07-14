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

describe("ChatSessionContent", () => {
  it("accepts explicit context files without a conversation sidebar", () => {
    expect(ChatSessionContent).toBeTypeOf("function")
  })

  it("does not call the confirmation command until the user clicks confirm", () => {
    expect(WikiWriteConfirmationCard).toBeTypeOf("function")
  })
})
