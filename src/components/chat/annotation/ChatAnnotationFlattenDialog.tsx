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
 */
import { useTranslation } from "react-i18next"
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
  const { t } = useTranslation()
  if (!open) return null

  const messageCount = annotation.thread.length
  const preview = annotation.thread
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(0, PREVIEW_MAX_CHARS)

  return (
    <dialog
      open
      aria-label={t("annotation.flatten.title")}
      className="rounded border border-border bg-background p-4 text-sm shadow-md"
    >
      <h3 className="text-base font-medium">{t("annotation.flatten.title")}</h3>
      <p className="mt-2">{t("annotation.flatten.description", { count: messageCount })}</p>
      <details className="mt-2">
        <summary className="cursor-pointer">
          {t("annotation.flatten.previewLabel", { count: PREVIEW_MAX_CHARS })}
        </summary>
        <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
          {preview}
        </pre>
      </details>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border bg-background px-3 py-1 text-xs"
        >
          {t("annotation.flatten.cancel")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded border border-blue-500 bg-blue-500 px-3 py-1 text-xs text-white"
        >
          {t("annotation.flatten.confirm")}
        </button>
      </div>
    </dialog>
  )
}
