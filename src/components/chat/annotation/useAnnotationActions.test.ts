// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook } from "@testing-library/react"
import { useAnnotationActions } from "./useAnnotationActions"
import { useChatStore } from "@/stores/chat-store"

const invokeMock = vi.fn()

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("useAnnotationActions.askAnnotationQuestion", () => {
  beforeEach(() => {
    // Reset the store to a known clean state so we don't leak annotations
    // between tests.
    useChatStore.setState({
      conversations: [],
      activeConversationId: "c1",
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "Long answer",
          timestamp: 1,
          conversationId: "c1",
        },
      ],
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
    invokeMock.mockResolvedValue("ok")
  })

  it("creates an annotation, appends the user question, and invokes the backend", () => {
    const { result } = renderHook(() => useAnnotationActions())
    const annotationId = result.current.askAnnotationQuestion({
      parentMessageId: "m1",
      snippet: "Long answer",
      range: undefined,
      question: "follow-up",
    })
    expect(annotationId).toMatch(/^ann_/)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    const [command, payload] = invokeMock.mock.calls[0]
    expect(command).toBe("agent_start_turn_stream")
    expect(payload).toMatchObject({
      projectId: "current",
      request: {
        message: "follow-up",
        sessionId: "c1",
        mode: "standard",
        retrievalMode: "standard",
        stream: true,
        annotation: expect.objectContaining({
          parentMessageId: "m1",
          parentMessageContent: "Long answer",
          snippet: "Long answer",
          thread: [],
          status: "open",
        }),
      },
    })
    // The annotation row should now carry the user question.
    const ann = useChatStore
      .getState()
      .messages.find((m) => m.id === "m1")
      ?.annotations?.find((a) => a.id === annotationId)
    expect(ann?.thread).toHaveLength(1)
    expect(ann?.thread[0].role).toBe("user")
    expect(ann?.thread[0].content).toBe("follow-up")
    // The annotation field on the request should match the id we got back.
    expect(payload.request.annotation.annotationId).toBe(annotationId)
  })

  it("returns null when the parent message does not exist", () => {
    const { result } = renderHook(() => useAnnotationActions())
    const annotationId = result.current.askAnnotationQuestion({
      parentMessageId: "missing",
      snippet: "snippet",
      range: undefined,
      question: "follow-up",
    })
    expect(annotationId).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("returns null and does not invoke when the question is empty", () => {
    const { result } = renderHook(() => useAnnotationActions())
    const annotationId = result.current.askAnnotationQuestion({
      parentMessageId: "m1",
      snippet: "snippet",
      range: undefined,
      question: "   ",
    })
    expect(annotationId).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("does not throw when the backend invoke rejects", () => {
    invokeMock.mockRejectedValueOnce(new Error("backend down"))
    const { result } = renderHook(() => useAnnotationActions())
    // Should not throw — the action swallows the invoke rejection.
    expect(() =>
      result.current.askAnnotationQuestion({
        parentMessageId: "m1",
        snippet: "snippet",
        range: undefined,
        question: "follow-up",
      }),
    ).not.toThrow()
  })
})
