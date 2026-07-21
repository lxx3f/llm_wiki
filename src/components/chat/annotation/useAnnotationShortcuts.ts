import { useEffect } from "react"

export interface AnnotationShortcutsCallbacks {
  /**
   * Called when the user presses the snippet-create shortcut
   * (`Cmd/Ctrl+K`). Implementations typically inspect the
   * current window selection, find the parent assistant message
   * via `closest('[data-message-id]')`, and call
   * `useAnnotationActions().createAnnotation(...)`.
   */
  onCreate: () => void
  /**
   * Called when the user presses the drawer-toggle shortcut
   * (`Cmd/Ctrl+Shift+A`). Implementations typically flip
   * `useChatStore.getState().annotationDrawerOpen` so the right
   * column shows or hides the annotation drawer.
   */
  onToggleDrawer: () => void
}

/**
 * Mount inside `ChatSessionContent` (or anywhere with stable lifetime)
 * to wire the annotation keyboard shortcuts onto `window`'s `keydown`:
 *
 * - `Cmd/Ctrl + K` → snippet-create from current selection
 * - `Cmd/Ctrl + Shift + A` → toggle the annotation drawer
 * - `Escape` → intentionally a no-op (folded / closed by consumer)
 *
 * The Escape handler is intentionally minimal: the consuming component
 * owns "what counts as a focusable drawer" and where to send the
 * collapse / close event. This hook only fans out keyboard intent.
 *
 * `Cmd` (`metaKey`) covers macOS / Tauri webviews; `Ctrl` (`ctrlKey`)
 * covers Windows / Linux. Both modifier keys route to the same
 * handler so the binding is platform-agnostic.
 */
export function useAnnotationShortcuts({
  onCreate,
  onToggleDrawer,
}: AnnotationShortcutsCallbacks): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && !e.shiftKey && e.key === "k") {
        e.preventDefault()
        onCreate()
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault()
        onToggleDrawer()
        return
      }
      if (e.key === "Escape") {
        // Intentionally no-op: collapsing the drawer / closing
        // popovers is the consumer's responsibility (so the same
        // Escape can later collapse WikiPageAssistant or other
        // right-pane surfaces without ambiguity).
        return
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onCreate, onToggleDrawer])
}