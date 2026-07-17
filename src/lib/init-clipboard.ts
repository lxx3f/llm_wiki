/**
 * Install a top-level bridge so that webview selection clipboard events
 * (`copy` / `cut`) round-trip through our foreground-aware Rust
 * command (`write_clipboard_text_for_history`), instead of being
 * handled by the WebView2 child process directly.
 *
 * Why this is needed:
 *
 * Tauri v2 webviews run inside `msedgewebview2.exe` (a Chromium child
 * process). The webview's own copy handling writes to the OS clipboard
 * with the WebView2 process as the writer, NOT `llm-wiki.exe`. On
 * Windows 11 24H2+ the "Clipboard history" service filters writes by
 * writer process and only catalogs foreground-attributed desktop apps;
 * WebView2's write is dropped, so `Win+V` doesn't show selections
 * copied inside the app even though they paste correctly into other
 * apps.
 *
 * This bridge installs `capture`-phase listeners with
 * `preventDefault()` so the webview's internal handler never fires
 * first, then calls our custom Rust command (NOT the generic
 * `tauri-plugin-clipboard-manager` `writeText`) which:
 *   1. Brings the main window foreground via `SetForegroundWindow`.
 *   2. Sleeps 50ms so Win11's foreground state settles.
 *   3. Writes via arboard so llm-wiki.exe is the OS-attributed writer.
 * The Rust side also calls `AddClipboardFormatListener` once at startup
 * so Win11's Clipboard History eligibility list includes us.
 *
 * Side effect: pressing `Ctrl+X` inside an `<input>` / `<textarea>` will
 * route through the same bridge instead of the webview default — that's
 * expected and desired.
 */

import { invoke } from "@tauri-apps/api/core"

let installed = false

/**
 * Install the clipboard bridge. Safe to call multiple times; only the
 * first call has effect. Should be called once during app startup,
 * before any React tree mounts, so the very first Ctrl+C inside the
 * app is captured.
 */
export function installClipboardBridge(): void {
  if (installed) return
  if (typeof document === "undefined") return
  installed = true

  const flushCopy = async (event: ClipboardEvent) => {
    // Selection-based copy/cut: pull the live selection text and push
    // it through our foreground-aware IPC. The Rust command attributes
    // the write to llm-wiki.exe so Win+V Clipboard History catalogs
    // it. See src-tauri/src/clipboard_history.rs.
    const text = window.getSelection()?.toString() ?? ""
    if (!text) return
    // Prevent the webview default so we don't end up with two stacked
    // clipboard formats (CF_UNICODETEXT from us + CF_HTML from webview).
    event.preventDefault()
    event.stopPropagation()
    try {
      await invoke("write_clipboard_text_for_history", { text })
    } catch (err) {
      console.error(`[clipboard-bridge] ${event.type} failed:`, err)
    }
  }

  // Capture phase + highest priority so the webview's internal handler
  // never fires first. `cut` only routes through for editable surfaces,
  // but the webview's cut is what would have written to the clipboard.
  document.addEventListener("copy", flushCopy, { capture: true })
  document.addEventListener("cut", flushCopy, { capture: true })
}
