/**
 * Reusable `<ul>` of `ChatAnnotation` rows used by the right-pane
 * drawer (and any future surface that needs the same list — e.g. a
 * popover, sidebar widget, search-result chip list). Each row is a
 * `<button>` so the list is keyboard-focusable and emits a single
 * `onSelect(id)` when the user picks an annotation.
 *
 * The drawer keeps its own selection state and passes the active
 * id down via `selectedId` so this component is purely controlled
 * — making it independently testable without depending on
 * ChatAnnotationInline / ChatAnnotationDrawer.
 */
import type { ChatAnnotation } from "../../../lib/chat-agent-types"

export interface ChatAnnotationListProps {
  annotations: ChatAnnotation[]
  selectedId?: string | null
  onSelect?: (id: string) => void
}

// Mirror `ChatAnnotationInline`'s preview so the list and the
// header read consistently (status color + truncated snippet).
const SNIPPET_PREVIEW_MAX = 30

function statusColor(status: ChatAnnotation["status"]): string {
  if (status === "open") return "text-blue-600"
  if (status === "resolved") return "text-green-600"
  return "text-muted-foreground"
}

function snippetPreview(snippet: string): string {
  return snippet.length > SNIPPET_PREVIEW_MAX
    ? `${snippet.slice(0, SNIPPET_PREVIEW_MAX)}…`
    : snippet
}

export function ChatAnnotationList({ annotations, selectedId, onSelect }: ChatAnnotationListProps) {
  if (annotations.length === 0) {
    return (
      <div className="rounded border border-dashed border-border/60 px-2 py-3 text-center text-[11px] text-muted-foreground">
        {/* TODO(i18n): move to `annotation.list.empty` in Task 7.3. */}
        还没有追问
      </div>
    )
  }

  return (
    <ul className="space-y-1" data-testid="chat-annotation-list">
      {annotations.map((annotation) => {
        const isSelected = annotation.id === selectedId
        return (
          <li key={annotation.id}>
            <button
              type="button"
              onClick={() => onSelect?.(annotation.id)}
              aria-pressed={isSelected}
              className={`flex w-full items-start gap-2 rounded border px-2 py-1 text-left text-xs transition-colors ${
                isSelected
                  ? "border-primary/50 bg-primary/10"
                  : "border-border/60 bg-background hover:border-primary/30 hover:bg-primary/5"
              }`}
            >
              <span className={`min-w-0 flex-1 truncate ${statusColor(annotation.status)}`}>
                {snippetPreview(annotation.snippet)}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {/* TODO(i18n): → `annotation.status.*` keys in Task 7.3. */}
                {annotation.status === "open"
                  ? "追问中"
                  : annotation.status === "resolved"
                    ? "已解决"
                    : "已压平"}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
