import { useAnnotationActions } from "./useAnnotationActions"

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
 * owns the hover target). Clicking the button asks the active
 * `useAnnotationActions().createAnnotation` hook to start an
 * annotation bound to the whole paragraph text — no selection
 * required. The `range` is explicitly `undefined` because the
 * annotation targets the full paragraph, not a substring.
 */
export function PerParagraphTrigger({ paragraph, parentMessageId }: PerParagraphTriggerProps) {
  const { createAnnotation } = useAnnotationActions()
  return (
    <button
      type="button"
      aria-label="针对此段追问"
      onClick={() => createAnnotation({
        parentMessageId,
        snippet: paragraph,
        range: undefined,
      })}
      className="opacity-0 group-hover:opacity-100 transition-opacity text-xs"
    >
      💬
    </button>
  )
}