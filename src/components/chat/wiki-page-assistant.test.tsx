import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./chat-session-content", () => ({
  ChatSessionContent: ({ contextFiles, wikiWriteMode }: { contextFiles: string[]; wikiWriteMode: string }) => (
    <output data-testid="session-probe" data-context-files={contextFiles.join(",")} data-write-mode={wikiWriteMode} />
  ),
}))

import { WikiPageAssistant, createWikiPageAssistantActions, getAvailableWikiPageChoices } from "./wiki-page-assistant"
import { useChatStore, type Conversation } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"

const originalChatState = useChatStore.getState()
const originalWikiState = useWikiStore.getState()
const project = { id: "project", name: "Project", path: "C:/p" }

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return { id: "conversation-1", title: "Page chat", createdAt: 1, updatedAt: 1, manualContextFiles: ["wiki/related.md"], wikiWriteMode: "confirm", ...overrides }
}

function seed(isStreaming = false) {
  const current = conversation()
  useChatStore.setState({ conversations: [current], activeConversationId: current.id, isStreaming })
  useWikiStore.setState({ project })
  return current
}

function actions(isStreaming: boolean, manualContextFiles = ["wiki/related.md"], onOpenFullChat = vi.fn()) {
  const state = useChatStore.getState()
  const setActiveView = vi.fn()
  return { setActiveView, onOpenFullChat, actions: createWikiPageAssistantActions({ isStreaming, manualContextFiles, createConversation: state.createConversation, setActiveConversation: state.setActiveConversation, setManualContextFiles: state.setManualContextFiles, setWikiWriteMode: state.setWikiWriteMode, setActiveView, onOpenFullChat }) }
}

afterEach(() => {
  useChatStore.setState(originalChatState, true)
  useWikiStore.setState(originalWikiState, true)
})

describe("WikiPageAssistant", () => {
  it("keeps automatic and manual pages ordered for the ChatSessionContent context", () => {
    seed()
    const first = renderToStaticMarkup(<WikiPageAssistant automaticPagePath="C:/p/wiki/first.md" />)
    const second = renderToStaticMarkup(<WikiPageAssistant automaticPagePath="C:/p/wiki/second.md" />)
    expect(first).toContain("data-testid=\"session-probe\"")
    expect(second).toContain("data-testid=\"session-probe\"")
    expect(getAvailableWikiPageChoices("C:/p", [{ path: "C:/p/wiki/first.md" }, { path: "C:/p/wiki/related.md" }], "C:/p/wiki/first.md", ["wiki/related.md"])).toEqual([])
  })

  it("updates the active conversation manual pages and write mode through the component actions", () => {
    seed()
    const { actions: controls } = actions(false)
    controls.addManualContextFile("wiki/extra.md")
    controls.setWriteMode("direct")
    expect(useChatStore.getState().conversations[0]).toMatchObject({ manualContextFiles: ["wiki/related.md", "wiki/extra.md"], wikiWriteMode: "direct" })
    actions(false, ["wiki/related.md", "wiki/extra.md"]).actions.removeManualContextFile("wiki/related.md")
    expect(useChatStore.getState().conversations[0].manualContextFiles).toEqual(["wiki/extra.md"])
  })

  it("filters add-page choices to unselected wiki Markdown files", () => {
    expect(getAvailableWikiPageChoices("C:/p", [{ path: "C:/p/wiki/current.md" }, { path: "C:/p/wiki/related.md" }, { path: "C:/p/wiki/available.md" }, { path: "C:/p/raw/source.md" }, { path: "C:/p/wiki/.hidden.md" }, { path: "C:/p/wiki/note.txt" }], "C:/p/wiki/current.md", ["wiki/related.md"])).toEqual(["wiki/available.md"])
  })

  it("blocks streaming controls and restores full-chat navigation without changing the active conversation", () => {
    seed(true)
    const streaming = actions(true)
    streaming.actions.selectConversation("other")
    streaming.actions.createConversation()
    streaming.actions.addManualContextFile("wiki/extra.md")
    streaming.actions.removeManualContextFile("wiki/related.md")
    streaming.actions.setWriteMode("direct")
    streaming.actions.openFullChat()
    expect(useChatStore.getState().conversations).toHaveLength(1)
    expect(useChatStore.getState().conversations[0]).toMatchObject({ manualContextFiles: ["wiki/related.md"], wikiWriteMode: "confirm" })
    expect(streaming.setActiveView).not.toHaveBeenCalled()
    const markup = renderToStaticMarkup(<WikiPageAssistant automaticPagePath="C:/p/wiki/first.md" />)
    expect(markup).toMatch(/Open full chat<\/button>/)
    expect(markup).toContain('disabled=""')

    useChatStore.setState({ isStreaming: false })
    const idle = actions(false)
    idle.actions.openFullChat()
    expect(idle.setActiveView).toHaveBeenCalledWith("chat")
    expect(useChatStore.getState().activeConversationId).toBe("conversation-1")
  })
})
