/**
 * Inline collapsible view of a `ChatAnnotation` (spec §3.1).
 *
 * Renders a compact `border-l-2 border-blue-300` block on the
 * parent assistant message (mounted by `chat-message.tsx`).
 * Collapsed by default — the header shows the snippet + status
 * label. Click the header to expand and see the annotation's
 * self-contained thread (Q&A) plus two action buttons:
 *
 *   - "✓ 明白了"      → `resolveAnnotation` (disabled when not `open`)
 *   - "插入主会话"   → `flattenAnnotation` (disabled when already `flattened`)
 *
 * Note: per the project CLAUDE.md i18n guideline, the strings
 * below are inlined as Chinese with a TODO marker until Task 7.3
 * formalizes the `annotation.*` namespace in `src/i18n/locales/{en,zh}.json`.
 */
import { useState } from "react"
import type { ChatAnnotation } from "../../../lib/chat-agent-types"
import { useAnnotationActions } from "./useAnnotationActions"
import { ChatAnnotationFlattenDialog } from "./ChatAnnotationFlattenDialog"

interface ChatAnnotationInlineProps {
  annotation: ChatAnnotation
}

const SNIPPET_PREVIEW_MAX = 30

function statusLabel(status: ChatAnnotation["status"]): string {
  // TODO(i18n): move to `annotation.status.*` keys in Task 7.3.
  if (status === "open") return "追问中"
  if (status === "resolved") return "已解决"
  return "已压平"
}

function statusColor(status: ChatAnnotation["status"]): string {
  // Slight color cue so users can tell at a glance whether an
  // annotation is still actionable, wrapped up, or merged back
  // into the main conversation.
  if (status === "open") return "text-blue-600"
  if (status === "resolved") return "text-green-600"
  return "text-muted-foreground"
}

export function ChatAnnotationInline({ annotation }: ChatAnnotationInlineProps) {
  const [open, setOpen] = useState(false)
  // Task 5.1: surface a confirmation dialog before flattening so the
  // user can preview what will be inserted. The store's
  // `flattenAnnotation` is idempotent, so the dialog doesn't need
  // to pre-check status — re-flattening is a no-op.
  const [showFlattenDialog, setShowFlattenDialog] = useState(false)
  const { resolveAnnotation, flattenAnnotation } = useAnnotationActions()

  const snippet = annotation.snippet
  const snippetPreview =
    snippet.length > SNIPPET_PREVIEW_MAX
      ? `${snippet.slice(0, SNIPPET_PREVIEW_MAX)}…`
      : snippet

  // TODO(i18n): move to `annotation.toggle.expand` / `.collapse` in Task 7.3.
  const toggleLabel = open ? "收起" : "展开"

  return (
    <div className="my-1 border-l-2 border-blue-300 pl-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        // The header doubles as the toggle — its visible text is
        // its accessible name (we deliberately do NOT set
        // `aria-label` so matching `getByText(/展开/)` / `展开` in
        // tests works without colliding with inner text). The
        // snippet + status remain visible to AT users.
        className={`text-xs hover:underline ${statusColor(annotation.status)}`}
      >
        💬 {snippetPreview} · {statusLabel(annotation.status)} · {toggleLabel}
      </button>
      {open && (
        <div className="mt-2 space-y-1 text-sm">
          {annotation.thread.map((message) => (
            <div key={message.id}>
              {/* TODO(i18n): Q/A role prefix → `annotation.role.user/assistant` */}
              <strong>{message.role === "user" ? "Q" : "A"}:</strong>{" "}
              {message.content}
            </div>
          ))}
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              // TODO(i18n): → `annotation.action.resolve`
              onClick={() => resolveAnnotation(annotation.id)}
              disabled={annotation.status !== "open"}
              className="rounded border border-border bg-background px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              ✓ 明白了
            </button>
            <button
              type="button"
              // TODO(i18n): → `annotation.action.flatten`
              onClick={() => setShowFlattenDialog(true)}
              disabled={annotation.status === "flattened"}
              className="rounded border border-border bg-background px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              插入主会话
            </button>
          </div>
        </div>
      )}
      <ChatAnnotationFlattenDialog
        annotation={annotation}
        open={showFlattenDialog}
        onClose={() => setShowFlattenDialog(false)}
        onConfirm={() => {
          flattenAnnotation(annotation.id)
          setShowFlattenDialog(false)
        }}
      />
    </div>
  )
}
