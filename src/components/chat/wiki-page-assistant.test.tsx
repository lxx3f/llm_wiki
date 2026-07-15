import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./chat-session-content", () => ({ ChatSessionContent: () => null }))

import {
  createWikiPageAssistantActions,
  getAvailableWikiPageChoices,
  getPageAssistantContextFiles,
} from "./wiki-page-assistant"
import { useChatStore, type Conversation } from "@/stores/chat-store"

const originalChatState = useChatStore.getState()

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation-1",
    title: "Page chat",
    createdAt: 1,
    updatedAt: 1,
    manualContextFiles: ["wiki/related.md"],
    wikiWriteMode: "confirm",
    ...overrides,
  }
}

function assistantActions(isStreaming: boolean, manualContextFiles = ["wiki/related.md"]) {
  const conversation = seedConversation({ manualContextFiles })
  useChatStore.setState({
    conversations: [conversation, seedConversation({ id: "conversation-2", title: "Other chat" })],
    activeConversationId: conversation.id,
    isStreaming,
  })
  const chat = useChatStore.getState()
  const setActiveView = vi.fn()
  return {
    actions: createWikiPageAssistantActions({
      isStreaming,
      manualContextFiles,
      createConversation: chat.createConversation,
      setActiveConversation: chat.setActiveConversation,
      setManualContextFiles: chat.setManualContextFiles,
      setWikiWriteMode: chat.setWikiWriteMode,
      setActiveView,
    }),
    setActiveView,
  }
}

afterEach(() => {
  useChatStore.setState(originalChatState, true)
})

describe("WikiPageAssistant", () => {
  it("replaces the automatic page while preserving the active conversation manual pages", () => {
    const projectPath = "C:/p"
    const manualContextFiles = ["wiki/related.md"]

    expect(getPageAssistantContextFiles(projectPath, "C:/p/wiki/first.md", manualContextFiles)).toEqual([
      "wiki/first.md",
      "wiki/related.md",
    ])
    expect(getPageAssistantContextFiles(projectPath, "C:/p/wiki/second.md", manualContextFiles)).toEqual([
      "wiki/second.md",
      "wiki/related.md",
    ])
    expect(manualContextFiles).toEqual(["wiki/related.md"])
  })

  it("updates active conversation manual pages and write mode", () => {
    const { actions } = assistantActions(false)

    actions.addManualContextFile("wiki/extra.md")
    actions.setWriteMode("direct")

    let conversation = useChatStore.getState().conversations[0]
    expect(conversation.manualContextFiles).toEqual(["wiki/related.md", "wiki/extra.md"])
    expect(conversation.wikiWriteMode).toBe("direct")

    assistantActions(false, conversation.manualContextFiles).actions.removeManualContextFile("wiki/related.md")
    conversation = useChatStore.getState().conversations[0]
    expect(conversation.manualContextFiles).toEqual(["wiki/extra.md"])
  })

  it("filters manual-page choices to unselected wiki Markdown files", () => {
    const choices = getAvailableWikiPageChoices(
      "C:/p",
      [
        { path: "C:/p/wiki/current.md" },
        { path: "C:/p/wiki/related.md" },
        { path: "C:/p/wiki/available.md" },
        { path: "C:/p/raw/sources/source.md" },
        { path: "C:/p/wiki/.hidden.md" },
        { path: "C:/p/wiki/not-markdown.txt" },
      ],
      "C:/p/wiki/current.md",
      ["wiki/related.md"],
    )

    expect(choices).toEqual(["wiki/available.md"])
  })

  it("disables every page-assistant state transition while streaming", () => {
    const { actions, setActiveView } = assistantActions(true)
    const before = useChatStore.getState()

    actions.selectConversation("conversation-2")
    actions.createConversation()
    actions.addManualContextFile("wiki/extra.md")
    actions.removeManualContextFile("wiki/related.md")
    actions.setWriteMode("direct")
    actions.openFullChat()

    const after = useChatStore.getState()
    expect(after.activeConversationId).toBe(before.activeConversationId)
    expect(after.conversations).toHaveLength(before.conversations.length)
    expect(after.conversations[0].manualContextFiles).toEqual(["wiki/related.md"])
    expect(after.conversations[0].wikiWriteMode).toBe("confirm")
    expect(setActiveView).not.toHaveBeenCalled()
  })

  it("opens full chat without changing the active conversation when not streaming", () => {
    const { actions, setActiveView } = assistantActions(false)

    actions.openFullChat()

    expect(setActiveView).toHaveBeenCalledWith("chat")
    expect(useChatStore.getState().activeConversationId).toBe("conversation-1")
  })
})
