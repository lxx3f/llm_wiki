import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { deleteFile } from "@/commands/fs"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"

export interface ConversationSidebarProps {
  onNewConversation?: () => void
  onSelectConversation?: (id: string) => void
}

export function ConversationSidebar({ onNewConversation, onSelectConversation }: ConversationSidebarProps) {
  const { t } = useTranslation()
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const messages = useChatStore((s) => s.messages)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)

  return <div className="flex h-full w-[200px] flex-shrink-0 flex-col border-r bg-muted/30">
    <div className="border-b p-2"><Button variant="outline" size="sm" className="w-full gap-2" disabled={isStreaming} onClick={() => onNewConversation ? onNewConversation() : createConversation()}><Plus className="h-3.5 w-3.5" />{t("chat.newChat")}</Button></div>
    <div className="flex-1 overflow-y-auto py-1">
      {sorted.length === 0 ? <p className="px-3 py-4 text-center text-xs text-muted-foreground">{t("chat.noConversationsYet")}</p> : sorted.map((conversation) => <div key={conversation.id} className={`group relative mx-1 my-0.5 flex flex-col rounded-md px-2 py-1.5 text-sm transition-colors ${isStreaming ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${conversation.id === activeConversationId ? "bg-primary/10 text-primary" : "hover:bg-accent text-foreground"}`} onClick={() => { if (!isStreaming) (onSelectConversation ? onSelectConversation(conversation.id) : setActiveConversation(conversation.id)) }} onMouseEnter={() => setHoveredId(conversation.id)} onMouseLeave={() => setHoveredId(null)}>
        <div className="flex items-start justify-between gap-1"><span className="line-clamp-2 flex-1 text-xs font-medium leading-snug">{conversation.title}</span>{hoveredId === conversation.id && <button disabled={isStreaming} className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-50" onClick={(event) => { event.stopPropagation(); deleteConversation(conversation.id); const project = useWikiStore.getState().project; if (project) void deleteFile(`${project.path}/.llm-wiki/chats/${conversation.id}.json`).catch(() => {}) }}><Trash2 className="h-3 w-3" /></button>}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">{messages.filter((message) => message.conversationId === conversation.id).length} {t("chat.msgCount")}</div>
      </div>)}
    </div>
  </div>
}
