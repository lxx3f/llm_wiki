import { useState } from "react"
import { useAnnotationActions } from "./useAnnotationActions"
import { ChatAnnotationQuestionInput } from "./ChatAnnotationQuestionInput"

interface PerParagraphTriggerProps {
  paragraph: string
  parentMessageId: string
}

/**
 * Per-paragraph follow-up trigger (spec §3.2 entry B).
 *
 * Renders a small `💬` button that becomes visible when its
 * surrounding `group` container is hovered (the parent
 * `<div className="group relative">` wrapper in `chat-message.tsx`
 * owns the hover target). Clicking the button opens the question
 * popover anchored just below the button — the user types their
 * follow-up question there, and on submit the new
 * `askAnnotationQuestion` action creates the annotation row, appends
 * the user message to the thread, and dispatches the agent turn.
 * The `range` is explicitly `undefined` because the annotation
 * targets the full paragraph, not a substring.
 */
export function PerParagraphTrigger({ paragraph, parentMessageId }: PerParagraphTriggerProps) {
  const { askAnnotationQuestion } = useAnnotationActions()
  const [popoverState, setPopoverState] = useState<{
    anchor: { x: number; y: number }
    snippet: string
  } | null>(null)

  const onTriggerClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setPopoverState({
      anchor: { x: rect.left, y: rect.bottom + 4 },
      snippet: paragraph,
    })
  }

  const handleSubmit = (question: string) => {
    askAnnotationQuestion({
      parentMessageId,
      snippet: paragraph,
      range: undefined,
      question,
    })
    setPopoverState(null)
  }

  const handleCancel = () => {
    setPopoverState(null)
  }

  return (
    <>
      <button
        type="button"
        aria-label="针对此段追问"
        onClick={onTriggerClick}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-xs"
      >
        💬
      </button>
      <ChatAnnotationQuestionInput
        anchor={popoverState?.anchor ?? null}
        snippet={popoverState?.snippet ?? paragraph}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
      />
    </>
  )
}
