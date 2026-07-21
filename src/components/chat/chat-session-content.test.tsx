import { describe, expect, it, vi } from "vitest"

vi.mock("./chat-message", () => ({
  ChatMessage: () => null,
  StreamingMessage: () => null,
  useSourceFiles: () => undefined,
}))
vi.mock("@/components/editor/file-preview", () => ({ FilePreview: () => null }))
vi.mock("@/components/editor/wiki-reader", () => ({ WikiReader: () => null }))
vi.mock("@/components/editor/frontmatter-panel", () => ({ FrontmatterPanel: () => null }))

import { ChatSessionContent, WikiWriteConfirmationCard, routeAgentEventToAnnotation } from "./chat-session-content"

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

describe("routeAgentEventToAnnotation", () => {
  function makeStore(initial: { annotationsInFlight?: Set<string> } = {}) {
    const appendAnnotationMessage = vi.fn()
    const inFlight = new Set(initial.annotationsInFlight ?? [])
    const startAnnotationStream = vi.fn((annotationId: string) => {
      inFlight.add(annotationId)
    })
    const endAnnotationStream = vi.fn((annotationId: string) => {
      inFlight.delete(annotationId)
    })
    const store = {
      streamingTargets: { main: false, annotations: inFlight },
      appendAnnotationMessage,
      startAnnotationStream,
      endAnnotationStream,
    }
    return { store, appendAnnotationMessage, startAnnotationStream, endAnnotationStream, inFlight }
  }

  it("returns { handled: false } when the event has no annotationId", () => {
    const { store, appendAnnotationMessage } = makeStore()
    const result = routeAgentEventToAnnotation({ type: "messageDelta", text: "hi" }, store)
    expect(result).toEqual({ handled: false })
    expect(appendAnnotationMessage).not.toHaveBeenCalled()
  })

  it("appends the event text to the annotation thread without touching the main stream", () => {
    const { store, appendAnnotationMessage, startAnnotationStream } = makeStore()
    const result = routeAgentEventToAnnotation(
      { type: "messageDelta", text: "answer part 1", annotationId: "ann_1" },
      store,
    )
    expect(result).toEqual({ handled: true, finishedStream: false })
    expect(startAnnotationStream).toHaveBeenCalledOnce()
    expect(startAnnotationStream).toHaveBeenCalledWith("ann_1")
    expect(appendAnnotationMessage).toHaveBeenCalledExactlyOnceWith("ann_1", "assistant", "answer part 1")
  })

  it("does not re-start the annotation stream on subsequent events for the same id", () => {
    const { store, startAnnotationStream, appendAnnotationMessage } = makeStore({
      annotationsInFlight: new Set(["ann_1"]),
    })
    routeAgentEventToAnnotation(
      { type: "messageDelta", text: "second part", annotationId: "ann_1" },
      store,
    )
    expect(startAnnotationStream).not.toHaveBeenCalled()
    expect(appendAnnotationMessage).toHaveBeenCalledExactlyOnceWith("ann_1", "assistant", "second part")
  })

  it("marks the annotation stream finished and signals done on a terminal done event", () => {
    const { store, endAnnotationStream, startAnnotationStream, appendAnnotationMessage } = makeStore({
      annotationsInFlight: new Set(["ann_1"]),
    })
    const result = routeAgentEventToAnnotation(
      { type: "done", annotationId: "ann_1" },
      store,
    )
    expect(result).toEqual({ handled: true, finishedStream: true })
    expect(endAnnotationStream).toHaveBeenCalledExactlyOnceWith("ann_1")
    expect(startAnnotationStream).not.toHaveBeenCalled()
    expect(appendAnnotationMessage).not.toHaveBeenCalled()
  })

  it("falls back from text to message to output in order", () => {
    // No `text` → `message` is used
    const { store, appendAnnotationMessage } = makeStore({
      annotationsInFlight: new Set(["ann_1"]),
    })
    const a = routeAgentEventToAnnotation(
      { type: "routing", annotationId: "ann_1", message: "from-message" },
      store,
    )
    expect(a).toEqual({ handled: true, finishedStream: false })
    expect(appendAnnotationMessage).toHaveBeenCalledWith("ann_1", "assistant", "from-message")

    // Only `output` (no `text`, no `message`) → `output` is used
    appendAnnotationMessage.mockClear()
    const b = routeAgentEventToAnnotation(
      { type: "toolEnd", annotationId: "ann_1", output: "from-output" },
      store,
    )
    expect(b).toEqual({ handled: true, finishedStream: false })
    expect(appendAnnotationMessage).toHaveBeenCalledWith("ann_1", "assistant", "from-output")
  })
})
