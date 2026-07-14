import { ChatSessionContent } from "./chat-session-content"
import { useChatStore } from "@/stores/chat-store"

export let lastQueryPages: { title: string; path: string }[] = []

export function ChatPanel() {
  const selectedContextFiles = useChatStore((state) => state.selectedContextFiles)
  return <ChatSessionContent contextFiles={selectedContextFiles} showConversationControls />
}
