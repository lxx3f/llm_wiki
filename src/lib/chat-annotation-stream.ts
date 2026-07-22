import { useChatStore } from "@/stores/chat-store"
import type { ChatAgentStep } from "@/lib/chat-agent-types"

export interface BackendAgentEventPayload {
  sessionId: string
  runId?: string
  event?: {
    type: string
    text?: string
    message?: string
    tool?: string
    input?: string
    output?: string
    annotationId?: string
  }
}

export type AnnotationStreamResult =
  | { kind: "continue" }
  | { kind: "done" }
  | { kind: "error"; error: string }

function normalizeBackendToolName(tool: string): ChatAgentStep["tool"] {
  const normalized = tool.split(".").join("_")
  if (normalized === "wiki_search") return "wiki_search"
  if (["wiki_read_page", "workspace_read_file", "skills_load", "context_attach", "skill_read_file", "source_search", "deep_research_run"].includes(normalized)) return "project_file_read"
  if (["wiki_write_page", "wiki_edit_page", "workspace_write_file", "workspace_append_file", "workspace_edit_file"].includes(normalized)) return "project_files"
  if (normalized === "graph_search") return "graph_search"
  if (normalized === "web_search") return "web_search"
  if (normalized === "anytxt_search") return "anytxt_search"
  if (normalized === "shell_exec") return "shell_exec"
  return "unknown_tool"
}

function nextStepId(annotationId: string, tool: string, type: ChatAgentStep["type"]): string {
  return `annotation-${annotationId}-${type}-${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Route one backend event from a dedicated annotation run to its thread.
 * Tool lifecycle events remain structured `agentSteps`; only MessageDelta text
 * becomes assistant Markdown content. Events from other sessions or runs are
 * ignored so concurrent main-chat and annotation streams remain isolated.
 */
export function processAnnotationEvent(
  payload: BackendAgentEventPayload,
  annotationId: string,
  expectedRunId: string,
  expectedSessionId: string,
): AnnotationStreamResult {
  if (payload.sessionId !== expectedSessionId || payload.runId !== expectedRunId) return { kind: "continue" }

  const event = payload.event
  if (!event) return { kind: "continue" }

  const store = useChatStore.getState()
  if (!store.streamingTargets.annotations.has(annotationId)) store.startAnnotationStream(annotationId)

  if (event.type === "done") {
    store.endAnnotationStream(annotationId)
    return { kind: "done" }
  }

  if (event.type === "error") {
    store.endAnnotationStream(annotationId)
    return { kind: "error", error: event.message ?? "Agent stream failed" }
  }

  if (event.type === "toolStart" && event.tool) {
    store.appendAnnotationAgentStep(annotationId, {
      id: nextStepId(annotationId, event.tool, "tool_call"),
      type: "tool_call",
      tool: normalizeBackendToolName(event.tool),
      toolRaw: event.tool,
      message: event.input ?? event.tool,
      input: event.input,
      status: "running",
      timestamp: Date.now(),
    })
    return { kind: "continue" }
  }

  if (event.type === "toolEnd" && event.tool) {
    const output = event.output ?? ""
    const status = output.startsWith("failed:")
      ? "error"
      : output.startsWith("approval required:")
        ? "skipped"
        : "success"
    store.appendAnnotationAgentStep(annotationId, {
      id: nextStepId(annotationId, event.tool, "tool_result"),
      type: "tool_result",
      tool: normalizeBackendToolName(event.tool),
      toolRaw: event.tool,
      message: event.tool,
      output: event.output,
      status,
      timestamp: Date.now(),
    })
    return { kind: "continue" }
  }

  if (event.type === "messageDelta" && event.text) store.appendAnnotationMessage(annotationId, "assistant", event.text)
  return { kind: "continue" }
}
