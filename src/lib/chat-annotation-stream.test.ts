import { beforeEach, describe, expect, it } from "vitest"
import { processAnnotationEvent } from "./chat-annotation-stream"
import { useChatStore } from "@/stores/chat-store"

const annotationId = "ann_1"
const sessionId = "c1"
const runId = "ui-ann-1"

function payload(
  event: { type: string; text?: string; message?: string; tool?: string; input?: string; output?: string },
  overrides: { sessionId?: string; runId?: string } = {},
) {
  return {
    sessionId: overrides.sessionId ?? sessionId,
    runId: overrides.runId ?? runId,
    event,
  }
}

describe("processAnnotationEvent", () => {
  beforeEach(() => {
    useChatStore.setState({
      activeConversationId: sessionId,
      streamingTargets: { main: false, annotations: new Set() },
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "Parent answer",
          timestamp: 1,
          conversationId: sessionId,
          annotations: [
            {
              id: annotationId,
              parentMessageId: "m1",
              snippet: "Parent answer",
              status: "open",
              createdAt: 1,
              thread: [],
            },
          ],
        },
      ],
    })
  })

  it("returns done and ends the annotation stream for a matching done event", () => {
    useChatStore.getState().startAnnotationStream(annotationId)

    const result = processAnnotationEvent(
      payload({ type: "done" }),
      annotationId,
      runId,
      sessionId,
    )

    expect(result).toEqual({ kind: "done" })
    expect(useChatStore.getState().streamingTargets.annotations.has(annotationId)).toBe(false)
  })

  it("returns the backend error and ends the annotation stream", () => {
    useChatStore.getState().startAnnotationStream(annotationId)

    const result = processAnnotationEvent(
      payload({ type: "error", message: "agent failed" }),
      annotationId,
      runId,
      sessionId,
    )

    expect(result).toEqual({ kind: "error", error: "agent failed" })
    expect(useChatStore.getState().streamingTargets.annotations.has(annotationId)).toBe(false)
  })

  it.each([
    ["session", { sessionId: "other-session" }],
    ["run", { runId: "other-run" }],
  ])("filters events with a different %s id", (_label, overrides) => {
    const result = processAnnotationEvent(
      payload({ type: "messageDelta", text: "ignored" }, overrides),
      annotationId,
      runId,
      sessionId,
    )

    expect(result).toEqual({ kind: "continue" })
    const annotation = useChatStore.getState().messages[0].annotations?.[0]
    expect(annotation?.thread).toHaveLength(0)
    expect(useChatStore.getState().streamingTargets.annotations.has(annotationId)).toBe(false)
  })

  it("appends matching text events to the annotation thread", () => {
    const result = processAnnotationEvent(
      payload({ type: "messageDelta", text: "answer part" }),
      annotationId,
      runId,
      sessionId,
    )

    expect(result).toEqual({ kind: "continue" })
    const annotation = useChatStore.getState().messages[0].annotations?.[0]
    expect(annotation?.thread).toHaveLength(1)
    expect(annotation?.thread[0]).toMatchObject({
      role: "assistant",
      content: "answer part",
      threadKind: "annotation",
    })
    expect(useChatStore.getState().streamingTargets.annotations.has(annotationId)).toBe(true)
  })

  it("keeps tool lifecycle output out of the annotation Markdown body", () => {
    processAnnotationEvent(
      payload({ type: "toolStart", tool: "wiki.read_page", input: "wiki/concepts/pi.md" }),
      annotationId, runId, sessionId,
    )
    processAnnotationEvent(
      payload({ type: "toolEnd", tool: "wiki.read_page", output: `1 ---
2 # PI
Knowledge context: {...}` }),
      annotationId, runId, sessionId,
    )

    const thread = useChatStore.getState().messages[0].annotations?.[0].thread ?? []
    expect(thread).toHaveLength(1)
    expect(thread[0]).toMatchObject({ role: "assistant", content: "", threadKind: "annotation" })
    expect(thread[0].agentSteps).toEqual([
      expect.objectContaining({ type: "tool_call", toolRaw: "wiki.read_page", input: "wiki/concepts/pi.md", status: "running" }),
      expect.objectContaining({ type: "tool_result", toolRaw: "wiki.read_page", output: `1 ---
2 # PI
Knowledge context: {...}`, status: "success" }),
    ])
  })

  it("adds only messageDelta text to the assistant answer after tool activity", () => {
    processAnnotationEvent(payload({ type: "toolStart", tool: "wiki.read_page", input: "wiki/concepts/pi.md" }), annotationId, runId, sessionId)
    processAnnotationEvent(payload({ type: "toolEnd", tool: "wiki.read_page", output: "tool output" }), annotationId, runId, sessionId)
    processAnnotationEvent(payload({ type: "messageDelta", text: "**PI** is position interpolation." }), annotationId, runId, sessionId)

    const message = useChatStore.getState().messages[0].annotations?.[0].thread[0]
    expect(message?.content).toBe("**PI** is position interpolation.")
    expect(message?.content).not.toContain("tool output")
    expect(message?.agentSteps).toHaveLength(2)
  })

  it("marks failed tool output as an error", () => {
    processAnnotationEvent(payload({ type: "toolStart", tool: "wiki.search", input: "PI" }), annotationId, runId, sessionId)
    processAnnotationEvent(payload({ type: "toolEnd", tool: "wiki.search", output: "failed: search index unavailable" }), annotationId, runId, sessionId)

    const steps = useChatStore.getState().messages[0].annotations?.[0].thread[0].agentSteps
    expect(steps?.[1]).toMatchObject({ type: "tool_result", status: "error", output: "failed: search index unavailable" })
  })

  it("ignores unknown non-text events", () => {
    processAnnotationEvent(payload({ type: "referenceAdded", output: "should not render" }), annotationId, runId, sessionId)
    const annotation = useChatStore.getState().messages[0].annotations?.[0]
    expect(annotation?.thread).toHaveLength(0)
  })
})
