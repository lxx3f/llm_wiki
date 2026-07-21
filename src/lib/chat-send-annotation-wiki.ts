/**
 * chat-send-annotation-wiki.ts
 *
 * Builds the instruction text the Chat Agent receives when the user
 * asks to "save annotation to wiki" (Task 6.1+). The actual file
 * write still goes through the existing `wiki.write_page` Agent tool
 * so existing pages trigger the controlled `pending_writes`
 * confirmation flow (per project CLAUDE.md).
 *
 * Keeping the helper free of side effects (no `tauri.invoke`, no
 * store mutation) lets it ship as a pure utility that's easy to unit
 * test and easy to swap into another dispatch surface if we ever
 * add one. The actual `agent_start_turn_stream` invocation stays
 * inside `ChatSessionContent.handleSend` so the streaming lifecycle
 * (refs, abort, event routing, confirmation cards, etc.) is owned
 * by a single code path.
 */
import type { ChatAnnotation } from "./chat-agent-types"

export interface AnnotationWikiSavePayload {
  /** Wiki-relative target path the agent will write to. */
  targetPath: string
  /** Full markdown payload (frontmatter + body). */
  content: string
  /** Chat-Agent instruction text. Fed directly to `handleSend`. */
  instructionText: string
}

/**
 * Render the markdown payload (frontmatter + body) identically to
 * `SaveAnnotationToWikiDialog.buildMarkdownContent` — duplicated
 * intentionally to keep the helper decoupled from the React tree.
 * If the dialog's format changes, update this in lockstep so the
 * instruction text matches the content the user actually approved.
 */
function renderAnnotationContent(
  annotation: ChatAnnotation,
  title: string,
  includeSnippet: boolean,
  includeThread: boolean,
): string {
  const frontmatter = [
    "---",
    "source: chat-annotation",
    `annotation_id: ${annotation.id}`,
    `parent_message_id: ${annotation.parentMessageId}`,
    `title: ${JSON.stringify(title)}`,
    `snippet: ${JSON.stringify(annotation.snippet)}`,
    "---",
  ].join("\n")

  const bodyParts: string[] = []
  if (includeSnippet) {
    bodyParts.push(`> ${annotation.snippet}`)
  }
  if (includeThread) {
    bodyParts.push(
      annotation.thread
        .map((m) => `**${m.role}**: ${m.content}`)
        .join("\n\n"),
    )
  }

  return [frontmatter, bodyParts.filter(Boolean).join("\n\n")].join("\n\n")
}

/**
 * Build the instruction text for the Agent turn that performs the
 * `wiki.write_page` call. Returns a string suitable for `handleSend`.
 *
 * The instruction is intentionally direct: a single tool call,
 * fixed arguments, no content editing. The whole point of routing
 * the save through the agent is so existing pages pick up the
 * controlled `pending_writes` confirmation; if we let the agent
 * improvise, the confirmation flow is meaningless.
 */
export function buildAnnotationWikiSaveInstruction(
  annotation: ChatAnnotation,
  content: string,
  targetPath: string,
): string {
  return [
    "Save this annotation as a wiki page using the wiki.write_page tool.",
    "",
    "Call wiki.write_page with these exact arguments. Do not modify the content.",
    "",
    `Target path: \`${targetPath}\``,
    "",
    "Markdown content:",
    "```markdown",
    content,
    "```",
    "",
    `Annotation source: id=${annotation.id} parent_message_id=${annotation.parentMessageId}`,
  ].join("\n")
}

/**
 * Convenience wrapper: builds the full payload (target path, content,
 * instruction text) from raw dialog inputs. Callers that already
 * generated the markdown (e.g. the React dialog) can still use
 * `buildAnnotationWikiSaveInstruction` directly.
 */
export interface AnnotationSaveInputs {
  title: string
  includeSnippet: boolean
  includeThread: boolean
}

export function buildAnnotationWikiSavePayload(
  annotation: ChatAnnotation,
  inputs: AnnotationSaveInputs,
  targetPath: string,
): AnnotationWikiSavePayload {
  const content = renderAnnotationContent(
    annotation,
    inputs.title,
    inputs.includeSnippet,
    inputs.includeThread,
  )
  return {
    targetPath,
    content,
    instructionText: buildAnnotationWikiSaveInstruction(annotation, content, targetPath),
  }
}
