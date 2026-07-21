/**
 * SaveAnnotationToWikiDialog — Task 6.1 of the chat-annotation feature.
 *
 * Collects a title plus two inclusion toggles (snippet quote / full
 * thread) and asks the user to confirm before persisting the
 * annotation as a wiki page. The dialog generates the markdown
 * client-side (frontmatter + body) and emits it through an
 * `onSave(annotation, content, targetPath)` callback prop.
 *
 * The dialog is intentionally a thin UI scaffold: it does NOT touch
 * the store, dispatch any Tauri command, or own the Agent turn
 * lifecycle. The parent (typically `ChatSessionContent` via
 * `ChatMessage` → `ChatAnnotationInline`) supplies `onSave` so the
 * actual file write goes through the Chat Agent's existing
 * `wiki.write_page` tool. That tool routes through `pending_writes`
 * for existing pages (per project CLAUDE.md — wiki writes section),
 * giving us free confirmation flow without a parallel write path.
 *
 * The store's `saveAnnotationToWiki` action still owns recording the
 * `wikiPath` backlink on the annotation (so the Task 6.2 chip
 * appears). The parent decides when to call it — usually right after
 * the agent confirms the write — but the dialog itself stays free
 * of side effects so it's trivially testable.
 */
import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { ChatAnnotation } from "../../../lib/chat-agent-types"

const TITLE_DEFAULT_MAX = 40

/**
 * Reduce a user-entered title to a safe wiki filename stem. The dialog
 * keeps the visible title free-form (so users can edit freely), but the
 * filesystem path it persists uses only filename-safe characters. This is
 * intentionally simple — the agent / ingest layer still has the final say
 * on path canonicalization via `normalizePath` / `safe_join`.
 */
function sanitizeFilenameStem(title: string): string {
  return title
    .trim()
    .replace(/[\\/]+/g, "-") // collapse path separators
    .replace(/[<>:"|?*\x00-\x1f]+/g, "") // drop forbidden filename chars
    .replace(/\s+/g, "-") // whitespace to dash
    .replace(/-+/g, "-") // collapse repeats
    .replace(/^-|-$/g, "") // trim edge dashes
    .slice(0, 80) || "annotation"
}

function buildTargetPath(title: string): string {
  // Sits under wiki/research-notes/ so the project's existing wiki
  // directory layout is reused; follow-up work can let users pick a
  // different parent folder once the routing story is settled.
  return `wiki/research-notes/${sanitizeFilenameStem(title)}.md`
}

function buildMarkdownContent(
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
 * Result type returned from the parent's `onSave` callback. The
 * dialog awaits this so that, on failure, it can keep itself open
 * and surface an error notice with a retry button. On success
 * (`{ ok: true }`) the dialog auto-closes.
 */
export type SaveAnnotationResult = { ok: true } | { ok: false; error?: string }

interface SaveAnnotationToWikiDialogProps {
  annotation: ChatAnnotation
  open: boolean
  onClose: () => void
  /**
   * Called when the user confirms. Must return (or resolve to) a
   * `SaveAnnotationResult`. Async dispatchers are awaited so the
   * dialog can stay open until the parent reports success/failure.
   */
  onSave: (
    annotation: ChatAnnotation,
    content: string,
    targetPath: string,
  ) => SaveAnnotationResult | Promise<SaveAnnotationResult>
}

export function SaveAnnotationToWikiDialog({
  annotation,
  open,
  onClose,
  onSave,
}: SaveAnnotationToWikiDialogProps) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(() => annotation.snippet.slice(0, TITLE_DEFAULT_MAX))
  const [includeSnippet, setIncludeSnippet] = useState(true)
  const [includeThread, setIncludeThread] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  if (!open) return null

  const resetState = () => {
    setBusy(false)
    setErrorText(null)
  }

  const handleSave = async () => {
    const targetPath = buildTargetPath(title)
    const content = buildMarkdownContent(annotation, title, includeSnippet, includeThread)
    setBusy(true)
    setErrorText(null)
    try {
      const result = await onSave(annotation, content, targetPath)
      if (result && result.ok) {
        resetState()
        onClose()
        return
      }
      // Parent reported a logical failure (e.g. user canceled at the
      // agent confirmation). Surface a localized message and keep
      // the dialog open with a retry button.
      setBusy(false)
      setErrorText(t("annotation.saveToWiki.error.cancelled"))
    } catch (err) {
      // Parent threw — bubble the message up but keep the dialog open.
      setBusy(false)
      const message = err instanceof Error ? err.message : String(err)
      setErrorText(t("annotation.saveToWiki.error.failure", { message }))
    }
  }

  const handleRetry = () => {
    // Reset the error state then re-run the save. Title/toggles are
    // preserved so the user doesn't have to re-enter them.
    setErrorText(null)
    void handleSave()
  }

  return (
    <dialog
      open
      data-testid="save-annotation-to-wiki-dialog"
      aria-label={t("annotation.saveToWiki.title")}
      className="rounded border border-border bg-background p-4 text-sm shadow-md w-[420px]"
    >
      <h3 className="text-base font-medium">{t("annotation.saveToWiki.title")}</h3>
      <p className="mt-2 text-muted-foreground">{t("annotation.saveToWiki.description")}</p>
      <label className="mt-3 block">
        <span className="text-xs">{t("annotation.saveToWiki.titleLabel")}</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm disabled:opacity-60"
        />
      </label>
      <div className="mt-2 space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeSnippet}
            disabled={busy}
            onChange={(e) => setIncludeSnippet(e.target.checked)}
          />
          {t("annotation.saveToWiki.includeSnippet")}
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeThread}
            disabled={busy}
            onChange={(e) => setIncludeThread(e.target.checked)}
          />
          {t("annotation.saveToWiki.includeThread")}
        </label>
      </div>
      {errorText && (
        <p
          role="alert"
          data-testid="save-annotation-to-wiki-error"
          className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-700"
        >
          {errorText}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          data-role="cancel"
          onClick={() => {
            resetState()
            onClose()
          }}
          disabled={busy}
          className="rounded border border-border bg-background px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("annotation.saveToWiki.cancel")}
        </button>
        {errorText ? (
          <button
            type="button"
            data-role="retry"
            onClick={handleRetry}
            className="rounded border border-amber-500 bg-amber-500 px-3 py-1 text-xs text-white"
          >
            {t("annotation.saveToWiki.retry")}
          </button>
        ) : (
          <button
            type="button"
            data-role="confirm"
            onClick={handleSave}
            disabled={busy}
            className="rounded border border-blue-500 bg-blue-500 px-3 py-1 text-xs text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy
              ? t("annotation.saveToWiki.saving")
              : t("annotation.saveToWiki.confirm")}
          </button>
        )}
      </div>
    </dialog>
  )
}
