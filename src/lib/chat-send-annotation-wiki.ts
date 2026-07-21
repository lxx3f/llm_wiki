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
