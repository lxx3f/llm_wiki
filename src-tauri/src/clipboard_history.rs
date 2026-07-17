//! Windows-specific clipboard integration that makes the OS-level
//! Clipboard History (`Win+V`) catalog writes from `llm-wiki.exe`.
//!
//! ## Why this module exists
//!
//! On Windows 11 24H2 and later, the Clipboard History service filters
//! writers using two heuristics beyond "did SetClipboardData succeed":
//!
//! 1. **Foreground window attribution** — the process must own the
//!    foreground HWND at the moment of the write, otherwise the write
//!    is attributed to whichever process happens to be foreground.
//!    `arboard`'s default `Clipboard::new()` passes a NULL HWND to
//!    `OpenClipboard`, which Win11 may treat as "no owner".
//! 2. **Clipboard-format listener registration** — apps that want to
//!    be recognized as clipboard history contributors should call
//!    `AddClipboardFormatListener(hwnd)` once on their main window at
//!    startup. Win11 uses this registration list to decide which apps
//!    are eligible to add entries to the history.
//!
//! `tauri-plugin-clipboard-manager` (which uses `arboard` under the
//! hood) writes the data correctly but its writes are skipped by the
//! history service, so `Win+V` shows nothing copied from the webview —
//! even though paste into Notepad works. This module fixes that by:
//!
//! - Registering the main window as a format listener at app startup.
//! - Exposing `write_clipboard_text_for_history` that
//!   brings the main window foreground (Win11 requirement) and
//!   writes via `arboard` with an explicit HWND.

use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "windows")]
const CF_UNICODETEXT: u32 = 13;

/// Register the main window with the OS so Clipboard History recognizes
/// this app as a contributor. Idempotent; safe to call once at
/// startup. Has no effect on non-Windows platforms.
pub fn register_clipboard_history_listener<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "windows")]
    {
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(hwnd) = window.hwnd() {
                use windows::Win32::Foundation::HWND;
                let raw = HWND(hwnd.0);
                // SAFETY: `AddClipboardFormatListener` takes a raw HWND
                // and registers the calling thread's window as a
                // clipboard change listener. Returns BOOL; we ignore
                // failures. Without this on Win11 24H2+ the OS Clipboard
                // History service refuses to credit our subsequent
                // `arboard.set_text` writes.
                let result = unsafe {
                    windows::Win32::System::DataExchange::AddClipboardFormatListener(raw)
                };
                eprintln!(
                    "[clipboard-history] AddClipboardFormatListener hwnd={:?} ok={}",
                    raw.0,
                    result.is_ok()
                );
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

/// Write `text` to the OS clipboard in a way that Win11 Clipboard
/// History recognizes. Brings the main window foreground so the OS
/// attributes the write to `llm-wiki.exe`, then writes via `arboard`
/// with the main window's HWND set as the clipboard owner.
///
/// Returns an error only when the OS write itself fails (i.e. it is
/// never called for transient UI states). Forwards the OS-level result
/// up to the frontend so the JS bridge can show a toast on failure.
#[tauri::command]
pub async fn write_clipboard_text_for_history<R: Runtime>(
    app: AppHandle<R>,
    text: String,
) -> Result<(), String> {
    // Bring the main window to foreground so Win11 attributes this write
    // to llm-wiki.exe instead of msedgewebview2.exe. The HWND is dropped
    // (and the inner `*mut c_void` released) before the `await` so the
    // future stays `Send`.
    #[cfg(target_os = "windows")]
    {
        let raw_hwnd_ptr: Option<*mut core::ffi::c_void> =
            app.get_webview_window("main")
                .and_then(|w| w.hwnd().ok())
                .map(|h| h.0);
        if let Some(ptr) = raw_hwnd_ptr {
            // SAFETY: SetForegroundWindow takes a raw HWND. Returns
            // BOOL; we ignore failures.
            let _ = unsafe {
                windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(
                    windows::Win32::Foundation::HWND(ptr),
                )
            };
            // raw_hwnd_ptr (and HWND(ptr)) dropped here — no `*mut c_void`
            // crosses the await below.
        }
        // Win11 needs a brief delay after SetForegroundWindow for the
        // foreground state to settle before the clipboard write is
        // attributed. Edge / Chrome / Slack all do this.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // arboard is `!Send` (it pins a Windows clipboard handle to a
    // thread). Run on the blocking pool so the async command future
    // stays Send for Tauri's runtime.
    tauri::async_runtime::spawn_blocking(move || {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        clipboard.set_text(text).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
