/**
 * Confirmation dialog shown before an annotation is flattened back into
 * the main conversation (spec §3.3). The dialog is intentionally
 * decoupled from the store: it receives `onConfirm` / `onClose` props so
 * the parent (`ChatAnnotationInline`) decides what "confirm" means and
 * the dialog remains trivially testable with a `vi.fn()` callback.
 *
 * The store action `flattenAnnotation` is idempotent — re-flattening a
 * flattened annotation is a no-op — so the dialog does not need to
 * pre-check status; the store handles dedup on the call site.
 *
 * Note: per the project CLAUDE.md i18n guideline, the user-visible
 * strings are inlined as Chinese with `TODO(i18n)` markers until
 * Task 7.3 formalizes the `annotation.*` namespace.
 */
import type { ChatAnnotation } from "../../../lib/chat-agent-types"

const PREVIEW_MAX_CHARS = 200

interface ChatAnnotationFlattenDialogProps {
  annotation: ChatAnnotation
  open: boolean
  onClose: () => void
  onConfirm: () => void
}

export function ChatAnnotationFlattenDialog({
  annotation,
  open,
  onClose,
  onConfirm,
}: ChatAnnotationFlattenDialogProps) {
  if (!open) return null

  const messageCount = annotation.thread.length
  // TODO(i18n): → `annotation.flatten.previewSummary` in Task 7.3.
  const preview = annotation.thread
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(0, PREVIEW_MAX_CHARS)

  return (
    <dialog
      open
      // TODO(i18n): → `annotation.flatten.title` in Task 7.3.
      aria-label="插入主会话"
      className="rounded border border-border bg-background p-4 text-sm shadow-md"
    >
      {/* TODO(i18n): → `annotation.flatten.title` */}
      <h3 className="text-base font-medium">插入主会话</h3>
      {/* TODO(i18n): → `annotation.flatten.description` */}
      <p className="mt-2">
        将把旁注里的 {messageCount} 条消息插入到主 conversation 末尾。
      </p>
      <details className="mt-2">
        {/* TODO(i18n): → `annotation.flatten.previewLabel` */}
        <summary className="cursor-pointer">预览前 {PREVIEW_MAX_CHARS} 字</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
          {preview}
        </pre>
      </details>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          // TODO(i18n): → `annotation.flatten.cancel`
          onClick={onClose}
          className="rounded border border-border bg-background px-3 py-1 text-xs"
        >
          取消
        </button>
        <button
          type="button"
          // TODO(i18n): → `annotation.flatten.confirm`
          onClick={onConfirm}
          className="rounded border border-blue-500 bg-blue-500 px-3 py-1 text-xs text-white"
        >
          确认插入
        </button>
      </div>
    </dialog>
  )
}
