// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook } from "@testing-library/react"
import { useAnnotationActions } from "./useAnnotationActions"
import { useChatStore } from "@/stores/chat-store"

interface TestAgentEvent {
  sessionId: string
  runId?: string
  event: { type: string; message?: string }
}

type TauriEventHandler = (event: { payload: TestAgentEvent }) => void

const tauriInvokeMock = vi.fn<(
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>>()
const unregisterListenerMock = vi.fn()
const originalCreateAnnotation = useChatStore.getState().createAnnotation
let eventHandler: TauriEventHandler | undefined

function backendInvokeCall(): [string, Record<string, unknown>] | undefined {
  const call = tauriInvokeMock.mock.calls.find(([command]) => command === "agent_start_turn_stream")
  return call as [string, Record<string, unknown>] | undefined
}

function pluginListenCall(): [string, Record<string, unknown>] | undefined {
  const call = tauriInvokeMock.mock.calls.find(([command]) => command === "plugin:event|listen")
  return call as [string, Record<string, unknown>] | undefined
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("useAnnotationActions.askAnnotationQuestion", () => {
  beforeEach(() => {
    // Tauri's ESM packages are externalized by the current Vitest setup, so
    // exercise their public bridge through the same window internals they use.
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: tauriInvokeMock,
        transformCallback: (handler: TauriEventHandler) => {
          eventHandler = handler
          return 7
        },
      },
    })
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      configurable: true,
      value: { unregisterListener: unregisterListenerMock },
    })
    tauriInvokeMock.mockImplementation(async (command) => {
      if (command === "plugin:event|listen") return 42
      return "ok"
    })
    eventHandler = undefined

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
      streamingTargets: { main: false, annotations: new Set() },
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
      createAnnotation: originalCreateAnnotation,
    })
  })

  it("creates an annotation, registers first, appends the question, and invokes the backend", async () => {
    const { result } = renderHook(() => useAnnotationActions())
    const annotationId = await result.current.askAnnotationQuestion({
      parentMessageId: "m1",
      snippet: "Long answer",
      range: undefined,
      question: "follow-up",
    })
    expect(annotationId).toMatch(/^ann_/)

    const listenCall = pluginListenCall()
    const agentCall = backendInvokeCall()
    expect(listenCall?.[1]).toMatchObject({ event: "agent-event" })
    expect(agentCall).toBeDefined()
    const listenCallIndex = tauriInvokeMock.mock.calls.indexOf(listenCall!)
    const agentCallIndex = tauriInvokeMock.mock.calls.indexOf(agentCall!)
    expect(listenCallIndex).toBeLessThan(agentCallIndex)

    const [command, payload] = agentCall!
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
    expect((payload.request as { annotation: { annotationId: string } }).annotation.annotationId).toBe(annotationId)
  })

  it("returns null when the parent message does not exist", async () => {
    const { result } = renderHook(() => useAnnotationActions())
    const annotationId = await result.current.askAnnotationQuestion({
      parentMessageId: "missing",
      snippet: "snippet",
      range: undefined,
      question: "follow-up",
    })
    expect(annotationId).toBeNull()
    expect(pluginListenCall()).toBeUndefined()
    expect(backendInvokeCall()).toBeUndefined()
  })

  it("returns null and does not invoke when the question is empty", async () => {
    const { result } = renderHook(() => useAnnotationActions())
    const annotationId = await result.current.askAnnotationQuestion({
      parentMessageId: "m1",
      snippet: "snippet",
      range: undefined,
      question: "   ",
    })
    expect(annotationId).toBeNull()
    expect(pluginListenCall()).toBeUndefined()
    expect(backendInvokeCall()).toBeUndefined()
  })

  it("returns null without listening or invoking when annotation creation is rejected", async () => {
    useChatStore.setState({
      createAnnotation: vi.fn(() => null) as unknown as typeof originalCreateAnnotation,
    })
    const { result } = renderHook(() => useAnnotationActions())

    const annotationId = await result.current.askAnnotationQuestion({
      parentMessageId: "m1",
      snippet: "snippet",
      question: "follow-up",
    })

    expect(annotationId).toBeNull()
    expect(pluginListenCall()).toBeUndefined()
    expect(backendInvokeCall()).toBeUndefined()
  })

  it("unregisters its dedicated listener when the annotation stream is done", async () => {
    const { result } = renderHook(() => useAnnotationActions())
    const annotationId = await result.current.askAnnotationQuestion({
      parentMessageId: "m1",
      snippet: "snippet",
      question: "follow-up",
    })
    const payload = backendInvokeCall()?.[1] as {
      request: { sessionId: string; runId: string }
    }

    eventHandler?.({
      payload: {
        sessionId: payload.request.sessionId,
        runId: payload.request.runId,
        event: { type: "done" },
      },
    })

    expect(annotationId).toMatch(/^ann_/)
    expect(unregisterListenerMock).toHaveBeenCalledExactlyOnceWith("agent-event", 42)
  })

  it("does not reject and unregisters when the backend invoke fails", async () => {
    tauriInvokeMock.mockImplementation(async (command) => {
      if (command === "plugin:event|listen") return 42
      if (command === "agent_start_turn_stream") throw new Error("backend down")
      return "ok"
    })
    const { result } = renderHook(() => useAnnotationActions())

    await expect(result.current.askAnnotationQuestion({
      parentMessageId: "m1",
      snippet: "snippet",
      range: undefined,
      question: "follow-up",
    })).resolves.toMatch(/^ann_/)
    expect(unregisterListenerMock).toHaveBeenCalledExactlyOnceWith("agent-event", 42)
  })
})
