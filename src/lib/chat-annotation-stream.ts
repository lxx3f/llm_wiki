import { useChatStore } from "@/stores/chat-store"

export interface BackendAgentEventPayload {
  sessionId: string
  runId?: string
  event?: {
    type: string
    text?: string
    message?: string
    output?: string
    annotationId?: string
  }
}

export type AnnotationStreamResult =
  | { kind: "continue" }
  | { kind: "done" }
  | { kind: "error"; error: string }

/**
 * Route one backend event from a dedicated annotation run to its thread.
 * Events from other sessions or runs are ignored so concurrent main-chat and
 * annotation streams cannot write into each other's targets.
 */
export function processAnnotationEvent(
  payload: BackendAgentEventPayload,
  annotationId: string,
  expectedRunId: string,
  expectedSessionId: string,
): AnnotationStreamResult {
  if (payload.sessionId !== expectedSessionId || payload.runId !== expectedRunId) {
    return { kind: "continue" }
  }

  const event = payload.event
  if (!event) return { kind: "continue" }

  const store = useChatStore.getState()
  if (!store.streamingTargets.annotations.has(annotationId)) {
    store.startAnnotationStream(annotationId)
  }

  if (event.type === "done") {
    store.endAnnotationStream(annotationId)
    return { kind: "done" }
  }

  if (event.type === "error" && event.message) {
    store.endAnnotationStream(annotationId)
    return { kind: "error", error: event.message }
  }

  const text = event.text ?? event.message ?? event.output ?? ""
  if (text) {
    store.appendAnnotationMessage(annotationId, "assistant", text)
  }

  return { kind: "continue" }
}
