import { useRef, useState, type ReactNode } from "react"
import { getSelectionWithin } from "./selection-utils"
import { useAnnotationActions } from "./useAnnotationActions"
import { ChatAnnotationQuestionInput } from "./ChatAnnotationQuestionInput"
import type { DisplayMessage } from "@/stores/chat-store"

interface ChatAnnotationTriggerProps {
  message: DisplayMessage
  children: ReactNode
}

interface PopoverState {
  anchor: { x: number; y: number }
  snippet: string
  range: { start: number; end: number }
}

/**
 * Right-click trigger for snippet follow-up annotations.
 *
 * Plain `onContextMenu` handler on a wrapping div. When the user
 * right-clicks WITH a non-empty text selection inside the container,
 * opens the question popover anchored at the cursor; on submit,
 * dispatches `askAnnotationQuestion`. Empty or out-of-container
 * selections fall through to the default browser context menu.
 *
 * We deliberately do NOT use Radix ContextMenu here. Radix's
 * ContextMenu.Trigger installs an internal contextmenu listener that
 * captures selection state, which interferes with normal text
 * selection behavior on subsequent right-clicks (causing the
 * previously-captured selection to re-assert itself). The previous
 * intermediate "menu" step (single item, opens popover) is also
 * removed — right-click with selection goes straight to the popover.
 */
export function ChatAnnotationTrigger({ message, children }: ChatAnnotationTriggerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [popoverState, setPopoverState] = useState<PopoverState | null>(null)
  const { askAnnotationQuestion } = useAnnotationActions()

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return
    const sel = getSelectionWithin(containerRef.current)
    if (!sel) return
    e.preventDefault()
    setPopoverState({
      anchor: { x: e.clientX, y: e.clientY + 4 },
      snippet: sel.snippet,
      range: sel.range,
    })
  }

  const handleSubmit = (question: string) => {
    if (!popoverState) return
    askAnnotationQuestion({
      parentMessageId: message.id,
      snippet: popoverState.snippet,
      range: popoverState.range,
      question,
    })
    setPopoverState(null)
  }

  const handleCancel = () => {
    setPopoverState(null)
  }

  return (
    <>
      <div ref={containerRef} onContextMenu={handleContextMenu}>
        {children}
      </div>
      <ChatAnnotationQuestionInput
        anchor={popoverState?.anchor ?? null}
        snippet={popoverState?.snippet ?? ""}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
      />
    </>
  )
}