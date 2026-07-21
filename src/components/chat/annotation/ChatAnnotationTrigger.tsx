import { useRef, useState, type ReactNode } from "react"
import * as ContextMenu from "@radix-ui/react-context-menu"
import { useTranslation } from "react-i18next"
import { getSelectionWithin } from "./selection-utils"
import { useAnnotationActions } from "./useAnnotationActions"
import type { DisplayMessage } from "@/stores/chat-store"

interface ChatAnnotationTriggerProps {
  message: DisplayMessage
  children: ReactNode
}

interface MenuState {
  x: number
  y: number
  snippet: string
  range: { start: number; end: number }
}

/**
 * Right-click trigger for snippet follow-up annotations.
 *
 * Listens for `contextmenu` on its child container. When the user
 * has selected text WITHIN the container, opens a Radix
 * ContextMenu at the cursor with one item that creates a new
 * annotation bound to `message.id`. Empty or out-of-container
 * selections fall through to the default browser context menu.
 *
 * Positioning is `fixed` so portal placement is not clipped by
 * ancestors with `overflow: hidden`.
 */
export function ChatAnnotationTrigger({ message, children }: ChatAnnotationTriggerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [menuState, setMenuState] = useState<MenuState | null>(null)
  const { createAnnotation } = useAnnotationActions()

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return
    const sel = getSelectionWithin(containerRef.current)
    if (!sel) return
    e.preventDefault()
    setMenuState({
      x: e.clientX,
      y: e.clientY,
      snippet: sel.snippet,
      range: sel.range,
    })
  }

  const handleCreate = () => {
    if (!menuState) return
    createAnnotation({
      parentMessageId: message.id,
      snippet: menuState.snippet,
      range: menuState.range,
    })
    setMenuState(null)
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) setMenuState(null)
  }

  return (
    <ContextMenu.Root open={!!menuState} onOpenChange={handleOpenChange}>
      <ContextMenu.Trigger asChild>
        <div ref={containerRef} onContextMenu={handleContextMenu}>
          {children}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          style={{
            position: "fixed",
            left: menuState?.x ?? 0,
            top: menuState?.y ?? 0,
          }}
          className="z-50 min-w-[12rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <ContextMenu.Item
            onSelect={handleCreate}
            className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent focus:text-accent-foreground"
          >
            💬 {t("annotation.menu.contextPrompt")}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
