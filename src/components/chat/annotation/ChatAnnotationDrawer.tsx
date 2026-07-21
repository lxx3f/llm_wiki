/**
 * Right-pane drawer (spec §3.1) that lists every annotation
 * attached to a parent assistant message and lets the user pick
 * one to inspect inline. Mutually exclusive with the page
 * assistant / Research drawer at the AppLayout level — see the
 * `openDrawerFor` state in `chat-session-content.tsx`.
 *
 * Composition is intentionally thin:
 *   - `ChatAnnotationList` (the `<ul>` of pickable rows)
 *   - `ChatAnnotationInline` (the existing collapsible annotation
 *     view, reused verbatim so the drawer and inline-on-bubble
 *     presentations stay byte-for-byte identical).
 */
import { useState } from "react"
import type { DisplayMessage } from "@/stores/chat-store"
import { ChatAnnotationList } from "./ChatAnnotationList"
import { ChatAnnotationInline } from "./ChatAnnotationInline"

export interface ChatAnnotationDrawerProps {
  message: DisplayMessage
  open: boolean
  onClose: () => void
  /**
   * Optional fixed width override. ChatSessionContent currently uses
   * the AppLayout-level `rightWidth` for WikiPageAssistant, but the
   * drawer's own width lives here so it can also be embedded in
   * contexts without the AppLayout right-pane machinery.
   */
  width?: number
}

const DEFAULT_DRAWER_WIDTH = 360

export function ChatAnnotationDrawer({
  message,
  open,
  onClose,
  width = DEFAULT_DRAWER_WIDTH,
}: ChatAnnotationDrawerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const annotations = message.annotations ?? []
  const selected = annotations.find((annotation) => annotation.id === selectedId) ?? null

  if (!open) return null

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l bg-background"
      style={{ width }}
      aria-label="Annotation drawer"
    >
      <header className="flex min-h-10 items-center justify-between gap-2 border-b px-3 py-2">
        {/* TODO(i18n): → `annotation.drawer.title` in Task 7.3. */}
        <span className="text-xs font-medium">Annotations ({annotations.length})</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close drawer"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {/* TODO(i18n): → `annotation.drawer.close` in Task 7.3. */}
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <ChatAnnotationList
          annotations={annotations}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        {selected ? (
          <div className="mt-3 border-t pt-2">
            <ChatAnnotationInline annotation={selected} />
          </div>
        ) : annotations.length > 0 ? (
          <div className="mt-3 rounded border border-dashed border-border/60 px-2 py-3 text-center text-[11px] text-muted-foreground">
            {/* TODO(i18n): → `annotation.drawer.promptSelect` in Task 7.3. */}
            选择左侧条目查看详情
          </div>
        ) : null}
      </div>
    </aside>
  )
}
