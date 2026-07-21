/**
 * ChatAnnotationQuestionInput — floating popover that captures the user's
 * follow-up question for an annotation.
 *
 * Shown above (or near) the trigger that opened it (paragraph 💬 button,
 * right-click "Ask separately about this", or Cmd/Ctrl+K). The popover
 * pre-fills the snippet above the textarea as context for the user.
 *
 * Submit rules (per the design doc §2.3 / 3.2):
 *   - Enter (no Shift) → call `onSubmit(trimmed)` (empty value is a no-op)
 *   - Shift+Enter     → insert a newline (questions are usually one line,
 *                        but we keep the door open for multi-line edits)
 *   - Escape          → call `onCancel`
 *   - Click outside   → call `onCancel`
 *
 * The popover itself is a thin, presentational component: it does NOT
 * touch the store or invoke the backend. Its parent owns the side
 * effects (creating the annotation row, appending the user message,
 * dispatching the agent turn) so this stays trivially testable.
 */
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

export interface ChatAnnotationQuestionInputProps {
  /** Anchor position for the popover. When `null`, the popover is hidden. */
  anchor: { x: number; y: number } | null
  /** Snippet pre-filled above the textarea as context. */
  snippet: string
  /** Called with the trimmed question when the user submits. */
  onSubmit: (question: string) => void
  /** Called when the user dismisses (Esc / click-outside / cancel button). */
  onCancel: () => void
}

export function ChatAnnotationQuestionInput({
  anchor,
  snippet,
  onSubmit,
  onCancel,
}: ChatAnnotationQuestionInputProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Focus the textarea when the popover opens so the user can type
  // immediately. `anchor` becoming truthy is the "open" signal.
  useEffect(() => {
    if (anchor) {
      inputRef.current?.focus()
    }
  }, [anchor])

  // Click-outside-to-cancel. We attach the listener only while open
  // (anchor !== null) so we don't leak global handlers after unmount.
  // The popover root carries `data-annotation-question-input`, which
  // `event.target.closest(...)` consults to bail out when the click
  // happened inside the popover itself (textarea, buttons, …).
  useEffect(() => {
    if (!anchor) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest("[data-annotation-question-input]")) return
      onCancel()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [anchor, onCancel])

  if (!anchor) return null

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      const trimmed = value.trim()
      if (!trimmed) return
      onSubmit(trimmed)
      setValue("")
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
    }
  }

  const handleSendClick = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    onSubmit(trimmed)
    setValue("")
  }

  const handleCancelClick = () => {
    setValue("")
    onCancel()
  }

  const trimmed = value.trim()
  const canSend = trimmed.length > 0

  return (
    <div
      data-annotation-question-input
      role="dialog"
      aria-label={t("annotation.question.snippetLabel", { defaultValue: "Snippet" })}
      style={{
        position: "fixed",
        left: anchor.x,
        top: anchor.y,
        zIndex: 50,
      }}
      className="w-80 rounded-md border border-border bg-popover p-2 shadow-lg"
    >
      <div className="mb-1 line-clamp-2 text-xs text-muted-foreground">
        <span className="font-medium">{t("annotation.question.snippetLabel", { defaultValue: "Snippet" })}: </span>
        <span>"{snippet}"</span>
      </div>
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        placeholder={t("annotation.question.placeholder", { defaultValue: "针对这段追问…" })}
        className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary"
      />
      <div className="mt-1 flex justify-end gap-1 text-xs">
        <button
          type="button"
          onClick={handleCancelClick}
          className="rounded px-2 py-0.5 text-muted-foreground hover:bg-muted"
        >
          {t("annotation.question.cancel", { defaultValue: "取消" })}
        </button>
        <button
          type="button"
          onClick={handleSendClick}
          disabled={!canSend}
          className="rounded bg-primary px-2 py-0.5 text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("annotation.question.send", { defaultValue: "发送" })}
        </button>
      </div>
    </div>
  )
}
