import { beforeEach, describe, expect, it } from "vitest"
import { useChatStore } from "./chat-store"

describe("chat-store conversation isolation", () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [],
      activeConversationId: null,
      messages: [],
      isStreaming: false,
      streamingContent: "",
      mode: "chat",
      ingestSource: null,
      useWebSearch: false,
      useAnyTxtSearch: false,
      agentMode: "standard",
      retrievalMode: "standard",
      selectedSkills: [],
      selectedContextFiles: [],
      disabledSkills: [],
    })
  })

  it("defaults to standard retrieval and allows smart retrieval opt-in", () => {
    expect(useChatStore.getState().retrievalMode).toBe("standard")
    useChatStore.getState().setRetrievalMode("smart")
    expect(useChatStore.getState().retrievalMode).toBe("smart")
  })

  it("writes async assistant results back to the original conversation", () => {
    const store = useChatStore.getState()
    const first = store.createConversation()
    store.addMessageToConversation(first, "user", "first question")

    const second = useChatStore.getState().createConversation()
    expect(useChatStore.getState().activeConversationId).toBe(second)

    useChatStore
      .getState()
      .finalizeStreamForConversation(first, "first answer")

    const state = useChatStore.getState()
    const firstMessages = state.messages.filter((message) => message.conversationId === first)
    const secondMessages = state.messages.filter((message) => message.conversationId === second)

    expect(firstMessages.map((message) => message.content)).toEqual([
      "first question",
      "first answer",
    ])
    expect(secondMessages).toEqual([])
  })

  it("clears stale stream content when a new stream starts", () => {
    useChatStore.setState({
      streamingContent: "old conversation tokens",
      isStreaming: false,
    })

    useChatStore.getState().setStreaming(true)

    expect(useChatStore.getState().streamingContent).toBe("")
    expect(useChatStore.getState().isStreaming).toBe(true)
  })

  it("creates globally unique message ids across conversations", () => {
    const first = useChatStore.getState().createConversation()
    useChatStore.getState().addMessageToConversation(first, "user", "first")

    const second = useChatStore.getState().createConversation()
    useChatStore.getState().addMessageToConversation(second, "user", "second")

    const ids = useChatStore.getState().messages.map((message) => message.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("removes the last assistant message only from the active conversation", () => {
    useChatStore.setState({
      conversations: [
        { id: "c1", title: "One", createdAt: 1, updatedAt: 1 },
        { id: "c2", title: "Two", createdAt: 2, updatedAt: 2 },
      ],
      activeConversationId: "c2",
      messages: [
        { id: "same", conversationId: "c1", role: "assistant", content: "keep", timestamp: 1 },
        { id: "same", conversationId: "c2", role: "assistant", content: "remove", timestamp: 2 },
      ],
    })

    useChatStore.getState().removeLastAssistantMessage()

    expect(useChatStore.getState().messages).toEqual([
      { id: "same", conversationId: "c1", role: "assistant", content: "keep", timestamp: 1 },
    ])
  })

  it("clears stale stream content when creating or switching conversations", () => {
    const first = useChatStore.getState().createConversation()
    useChatStore.setState({
      streamingContent: "old conversation tokens",
      isStreaming: true,
    })

    const second = useChatStore.getState().createConversation()

    expect(useChatStore.getState().activeConversationId).toBe(second)
    expect(useChatStore.getState().streamingContent).toBe("")
    expect(useChatStore.getState().isStreaming).toBe(false)

    useChatStore.setState({
      streamingContent: "more stale tokens",
      isStreaming: true,
    })
    useChatStore.getState().setActiveConversation(first)

    expect(useChatStore.getState().activeConversationId).toBe(first)
    expect(useChatStore.getState().streamingContent).toBe("")
  })

  it("stores selected skills per conversation and starts new conversations empty", () => {
    const first = useChatStore.getState().createConversation()
    useChatStore.getState().setSelectedSkills(["cover-image"])

    const second = useChatStore.getState().createConversation()

    expect(useChatStore.getState().activeConversationId).toBe(second)
    expect(useChatStore.getState().selectedSkills).toEqual([])

    useChatStore.getState().setSelectedSkills(["ppt"])
    useChatStore.getState().setActiveConversation(first)

    expect(useChatStore.getState().selectedSkills).toEqual(["cover-image"])

    useChatStore.getState().setActiveConversation(second)

    expect(useChatStore.getState().selectedSkills).toEqual(["ppt"])
  })

  it("stores selected context files per conversation and starts new conversations empty", () => {
    const first = useChatStore.getState().createConversation()
    useChatStore.getState().setSelectedContextFiles(["wiki/overview.md"])

    const second = useChatStore.getState().createConversation()
    expect(useChatStore.getState().selectedContextFiles).toEqual([])

    useChatStore.getState().setSelectedContextFiles(["raw/sources/source.txt"])
    useChatStore.getState().setActiveConversation(first)
    expect(useChatStore.getState().selectedContextFiles).toEqual(["wiki/overview.md"])

    useChatStore.getState().setActiveConversation(second)
    expect(useChatStore.getState().selectedContextFiles).toEqual(["raw/sources/source.txt"])
  })

  it("keeps manual wiki context and write mode per conversation", () => {
    const first = useChatStore.getState().createConversation()
    useChatStore.getState().setManualContextFiles(["wiki/a.md", "wiki/a.md", "wiki/b.md"])
    useChatStore.getState().setWikiWriteMode("direct")
    const second = useChatStore.getState().createConversation()

    expect(useChatStore.getState().conversations.find((item) => item.id === second)).toMatchObject({
      manualContextFiles: [], wikiWriteMode: "confirm",
    })
    useChatStore.getState().setActiveConversation(first)
    expect(useChatStore.getState().conversations.find((item) => item.id === first)).toMatchObject({
      manualContextFiles: ["wiki/a.md", "wiki/b.md"], wikiWriteMode: "direct",
    })
  })

  it("stores the context file snapshot on the user message", () => {
    const conversationId = useChatStore.getState().createConversation()
    useChatStore.getState().addMessageToConversation(
      conversationId,
      "user",
      "summarize this",
      [],
      ["/project/wiki/overview.md"],
    )

    expect(useChatStore.getState().messages[0].contextFiles).toEqual([
      "/project/wiki/overview.md",
    ])
  })
})

describe("annotation CRUD", () => {
  beforeEach(() => useChatStore.setState({
    conversations: [], activeConversationId: null, messages: [],
    isStreaming: false, streamingContent: "",
  }))

  it("createAnnotation appends to parent message", () => {
    const store = useChatStore.getState()
    store.createConversation()
    const convId = useChatStore.getState().activeConversationId!
    store.addMessageToConversation(convId, "assistant", "Long answer A1, A2, A3.")
    const parentId = useChatStore.getState().messages[0].id

    const annId = store.createAnnotation(parentId, "A1", { start: 13, end: 15 })

    const msg = useChatStore.getState().messages.find(m => m.id === parentId)!
    expect(msg.annotations).toHaveLength(1)
    expect(msg.annotations![0].id).toBe(annId)
    expect(msg.annotations![0].status).toBe("open")
    expect(msg.annotations![0].snippet).toBe("A1")
    expect(msg.annotations![0].range).toEqual({ start: 13, end: 15 })
    expect(msg.annotations![0].thread).toEqual([])
  })

  it("appendAnnotationMessage pushes into thread", () => {
    const store = useChatStore.getState()
    store.createConversation()
    const convId = useChatStore.getState().activeConversationId!
    store.addMessageToConversation(convId, "assistant", "Body")
    const parentId = useChatStore.getState().messages[0].id
    const annId = store.createAnnotation(parentId, "snippet")

    store.appendAnnotationMessage(annId, "user", "What's A1?")
    store.appendAnnotationMessage(annId, "assistant", "A1 means ...")

    const ann = useChatStore.getState().messages
      .find(m => m.id === parentId)!.annotations![0]
    expect(ann.thread).toHaveLength(2)
    expect(ann.thread[0].role).toBe("user")
    expect(ann.thread[1].role).toBe("assistant")
  })

  it("resolveAnnotation transitions open -> resolved", () => {
    const store = useChatStore.getState()
    store.createConversation()
    const convId = useChatStore.getState().activeConversationId!
    store.addMessageToConversation(convId, "assistant", "Body")
    const parentId = useChatStore.getState().messages[0].id
    const annId = store.createAnnotation(parentId, "snippet")

    store.resolveAnnotation(annId)

    const ann = useChatStore.getState().messages
      .find(m => m.id === parentId)!.annotations![0]
    expect(ann.status).toBe("resolved")
  })

  it("flattenAnnotation copies thread into main conversation and marks flattened", () => {
    const store = useChatStore.getState()
    store.createConversation()
    const convId = useChatStore.getState().activeConversationId!
    store.addMessageToConversation(convId, "assistant", "Body")
    const parentId = useChatStore.getState().messages[0].id
    const annId = store.createAnnotation(parentId, "snippet")
    store.appendAnnotationMessage(annId, "user", "Q?")
    store.appendAnnotationMessage(annId, "assistant", "A.")

    const newIds = store.flattenAnnotation(annId)

    const ann = useChatStore.getState().messages
      .find(m => m.id === parentId)!.annotations![0]
    expect(ann.status).toBe("flattened")
    expect(ann.flattenedMessageIds).toEqual(newIds)
    expect(useChatStore.getState().messages.length).toBeGreaterThanOrEqual(3) // parent + 2 new

    // 主 conversation 末尾的新消息，flattenedFromAnnotation 标记
    const last2 = useChatStore.getState().messages.slice(-2)
    expect(last2[0].role).toBe("user")
    expect(last2[1].role).toBe("assistant")
    expect((last2[0] as any).flattenedFromAnnotation).toBe(annId)
    expect((last2[1] as any).flattenedFromAnnotation).toBe(annId)
  })

  it("createAnnotation throws if parent message not found", () => {
    expect(() =>
      useChatStore.getState().createAnnotation("nonexistent", "x")
    ).toThrow(/parent message not found/)
  })

  it("flattenAnnotation strips threadKind from flattened top-level messages", () => {
    const store = useChatStore.getState()
    store.createConversation()
    const convId = useChatStore.getState().activeConversationId!
    store.addMessageToConversation(convId, "assistant", "Body")
    const parentId = useChatStore.getState().messages[0].id
    const annId = store.createAnnotation(parentId, "snippet")
    store.appendAnnotationMessage(annId, "user", "Q?")
    store.appendAnnotationMessage(annId, "assistant", "A.")

    store.flattenAnnotation(annId)

    const flattenedTail = useChatStore
      .getState()
      .messages
      .filter((m) => m.flattenedFromAnnotation === annId)

    expect(flattenedTail).toHaveLength(2)
    for (const m of flattenedTail) {
      // After flatten, these messages are part of the main conversation history
      // (must NOT carry the annotation-thread marker that chatMessagesToLLM filters out).
      expect(m.threadKind).toBeUndefined()
      expect(m.flattenedFromAnnotation).toBe(annId)
    }
  })

  it("appendAnnotationMessage is a no-op once an annotation is flattened", () => {
    const store = useChatStore.getState()
    store.createConversation()
    const convId = useChatStore.getState().activeConversationId!
    store.addMessageToConversation(convId, "assistant", "Body")
    const parentId = useChatStore.getState().messages[0].id
    const annId = store.createAnnotation(parentId, "snippet")
    store.appendAnnotationMessage(annId, "user", "Q?")
    store.appendAnnotationMessage(annId, "assistant", "A.")
    store.flattenAnnotation(annId)

    // Snapshot pre-mutation state.
    const annBefore = useChatStore
      .getState()
      .messages
      .find((m) => m.id === parentId)!.annotations![0]
    expect(annBefore.status).toBe("flattened")
    const threadBefore = [...annBefore.thread]
    const totalBefore = useChatStore.getState().messages.length

    // Try to keep adding to a frozen thread — must not change anything.
    store.appendAnnotationMessage(annId, "user", "post-flatten follow-up")
    store.appendAnnotationMessage(annId, "assistant", "post-flatten reply")

    const annAfter = useChatStore
      .getState()
      .messages
      .find((m) => m.id === parentId)!.annotations![0]
    expect(annAfter.status).toBe("flattened")
    expect(annAfter.thread).toHaveLength(threadBefore.length)
    // Thread contents are byte-identical to the snapshot taken at flatten time.
    expect(annAfter.thread.map((m) => m.id)).toEqual(threadBefore.map((m) => m.id))

    // Main conversation is not mutated either.
    expect(useChatStore.getState().messages.length).toBe(totalBefore)
  })
})

describe("streamingTargets", () => {
  it("tracks parallel main + annotation streams", () => {
    const s = useChatStore.getState()
    s.startMainStream()
    s.startAnnotationStream("ann_1")
    s.startAnnotationStream("ann_2")
    const t = useChatStore.getState().streamingTargets
    expect(t.main).toBe(true)
    expect([...t.annotations]).toEqual(["ann_1", "ann_2"])
    s.endAnnotationStream("ann_1")
    expect([...useChatStore.getState().streamingTargets.annotations]).toEqual(["ann_2"])
    s.endMainStream()
    expect(useChatStore.getState().streamingTargets.main).toBe(false)
  })
})
