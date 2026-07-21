/**
 * SaveAnnotationToWikiDialog — Task 6.1 of the chat-annotation feature.
 *
 * Collects a title plus two inclusion toggles (snippet quote / full thread)
 * and asks the user to confirm before persisting the annotation as a wiki
 * page. The dialog generates the markdown client-side (frontmatter + body)
 * and routes the result through `useAnnotationActions().saveAnnotationToWiki`,
 * which currently only records the backlink path on the annotation record.
 *
 * Architectural note (per project CLAUDE.md — wiki writes section):
 *   In a fully-wired flow the actual file write goes through the Agent's
 *   `wiki.write_page` tool so existing pages trigger the controlled
 *   `pending_writes` confirmation. That end-to-end path is a follow-up task;
 *   the dialog is intentionally a thin UI scaffold today so the Task 6.2
 *   backlink chip has a real `wikiPath` to render.
 */
import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { ChatAnnotation } from "../../../lib/chat-agent-types"
import { useAnnotationActions } from "./useAnnotationActions"

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

interface SaveAnnotationToWikiDialogProps {
  annotation: ChatAnnotation
  open: boolean
  onClose: () => void
}

export function SaveAnnotationToWikiDialog({
  annotation,
  open,
  onClose,
}: SaveAnnotationToWikiDialogProps) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(() => annotation.snippet.slice(0, TITLE_DEFAULT_MAX))
  const [includeSnippet, setIncludeSnippet] = useState(true)
  const [includeThread, setIncludeThread] = useState(false)
  const { saveAnnotationToWiki } = useAnnotationActions()

  if (!open) return null

  const handleSave = () => {
    const targetPath = buildTargetPath(title)
    const content = buildMarkdownContent(annotation, title, includeSnippet, includeThread)
    // Note: the wiki write itself is deferred — see file header. Until the
    // Agent `wiki.write_page` wiring lands, this only updates the
    // annotation's `wikiPath` field so the Task 6.2 chip can render.
    // A user-facing toast can be wired up in a follow-up.
    saveAnnotationToWiki(annotation.id, targetPath, content)
    onClose()
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
          className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm"
        />
      </label>
      <div className="mt-2 space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeSnippet}
            onChange={(e) => setIncludeSnippet(e.target.checked)}
          />
          {t("annotation.saveToWiki.includeSnippet")}
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeThread}
            onChange={(e) => setIncludeThread(e.target.checked)}
          />
          {t("annotation.saveToWiki.includeThread")}
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          data-role="cancel"
          onClick={onClose}
          className="rounded border border-border bg-background px-3 py-1 text-xs"
        >
          {t("annotation.saveToWiki.cancel")}
        </button>
        <button
          type="button"
          data-role="confirm"
          onClick={handleSave}
          className="rounded border border-blue-500 bg-blue-500 px-3 py-1 text-xs text-white"
        >
          {t("annotation.saveToWiki.confirm")}
        </button>
      </div>
    </dialog>
  )
}
