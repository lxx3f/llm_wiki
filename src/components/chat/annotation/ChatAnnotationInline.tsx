/**
 * Inline collapsible view of a `ChatAnnotation` (spec §3.1).
 *
 * Renders a compact `border-l-2 border-blue-300` block on the
 * parent assistant message (mounted by `chat-message.tsx`).
 * Collapsed by default — the header shows the snippet + status
 * label. Click the header to expand and see the annotation's
 * self-contained thread (Q&A) plus action buttons:
 *
 *   - "✓ 明白了"      → `resolveAnnotation` (disabled when not `open`)
 *   - "插入主会话"   → `flattenAnnotation` (disabled when already `flattened`)
 *   - "保存为 Wiki"  → opens `SaveAnnotationToWikiDialog`, which routes
 *                     the actual file write through the Chat Agent's
 *                     `wiki.write_page` tool (Task 6.1 follow-up)
 */
import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { ChatAnnotation } from "../../../lib/chat-agent-types"
import { useWikiStore } from "@/stores/wiki-store"
import { useAnnotationActions } from "./useAnnotationActions"
import { ChatAnnotationFlattenDialog } from "./ChatAnnotationFlattenDialog"
import { SaveAnnotationToWikiDialog, type SaveAnnotationResult } from "./SaveAnnotationToWikiDialog"

interface ChatAnnotationInlineProps {
  annotation: ChatAnnotation
  /**
   * Optional callback that the parent supplies to handle the
   * "save annotation to wiki" flow. The dialog already generated the
   * markdown content + target path; the parent is responsible for
   * dispatching the Agent turn that calls `wiki.write_page`.
   *
   * If absent, the "save to wiki" button is hidden — useful when the
   * inline view is rendered in a context where the chat dispatch
   * surface isn't available (e.g. some test pages).
   */
  onSaveAnnotation?: (
    annotation: ChatAnnotation,
    content: string,
    targetPath: string,
  ) => SaveAnnotationResult | Promise<SaveAnnotationResult>
}

const SNIPPET_PREVIEW_MAX = 30

function statusColor(status: ChatAnnotation["status"]): string {
  // Slight color cue so users can tell at a glance whether an
  // annotation is still actionable, wrapped up, or merged back
  // into the main conversation.
  if (status === "open") return "text-blue-600"
  if (status === "resolved") return "text-green-600"
  return "text-muted-foreground"
}

export function ChatAnnotationInline({ annotation, onSaveAnnotation }: ChatAnnotationInlineProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Task 5.1: surface a confirmation dialog before flattening so the
  // user can preview what will be inserted. The store's
  // `flattenAnnotation` is idempotent, so the dialog doesn't need
  // to pre-check status — re-flattening is a no-op.
  const [showFlattenDialog, setShowFlattenDialog] = useState(false)
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const { resolveAnnotation, flattenAnnotation } = useAnnotationActions()

  const snippet = annotation.snippet
  const snippetPreview =
    snippet.length > SNIPPET_PREVIEW_MAX
      ? `${snippet.slice(0, SNIPPET_PREVIEW_MAX)}…`
      : snippet

  const toggleLabel = open ? t("annotation.toggle.collapse") : t("annotation.toggle.expand")
  const canSaveToWiki = Boolean(onSaveAnnotation) && annotation.status !== "flattened"

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
        💬 {snippetPreview} · {t(`annotation.status.${annotation.status}`)} · {toggleLabel}
      </button>
      {open && (
        <div className="mt-2 space-y-1 text-sm">
          {annotation.thread.map((message) => (
            <div key={message.id}>
              <strong>
                {message.role === "user"
                  ? t("annotation.role.user")
                  : t("annotation.role.assistant")}
                :
              </strong>{" "}
              {message.content}
            </div>
          ))}
          {annotation.wikiPath && (
            <button
              type="button"
              onClick={() => {
                const { setActiveView, setSelectedFile } = useWikiStore.getState()
                setActiveView("wiki")
                setSelectedFile(annotation.wikiPath ?? null)
              }}
              className="text-xs text-blue-600 hover:underline"
            >
              {t("annotation.wiki.saved")}
            </button>
          )}
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={() => resolveAnnotation(annotation.id)}
              disabled={annotation.status !== "open"}
              className="rounded border border-border bg-background px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("annotation.action.resolve")}
            </button>
            <button
              type="button"
              onClick={() => setShowFlattenDialog(true)}
              disabled={annotation.status === "flattened"}
              className="rounded border border-border bg-background px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("annotation.action.flatten")}
            </button>
            {canSaveToWiki && (
              <button
                type="button"
                onClick={() => setShowSaveDialog(true)}
                disabled={annotation.status === "flattened"}
                className="rounded border border-border bg-background px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="save-annotation-to-wiki-trigger"
              >
                {t("annotation.action.saveToWiki")}
              </button>
            )}
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
      {onSaveAnnotation && (
        <SaveAnnotationToWikiDialog
          annotation={annotation}
          open={showSaveDialog}
          onClose={() => setShowSaveDialog(false)}
          onSave={onSaveAnnotation}
        />
      )}
    </div>
  )
}
