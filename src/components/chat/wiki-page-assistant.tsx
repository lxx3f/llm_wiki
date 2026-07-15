import { useMemo } from "react"
import { ChevronDown, FilePlus2, MessageSquare, X } from "lucide-react"
import { ChatSessionContent } from "./chat-session-content"
import { Button } from "@/components/ui/button"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { getWikiContextFiles } from "@/lib/wiki-page-context"

interface WikiPageAssistantProps {
  automaticPagePath: string | null
  onClose?: () => void
  onOpenFullChat?: () => void
}

export function getAvailableWikiPageChoices(
  projectPath: string,
  entries: Iterable<{ path: string }>,
  automaticPagePath: string | null,
  manualContextFiles: string[],
): string[] {
  const excluded = new Set(getWikiContextFiles(projectPath, automaticPagePath, manualContextFiles))
  return Array.from(new Set(Array.from(entries, ({ path }) => getWikiContextFiles(projectPath, normalizePath(path), [])[0])
    .filter((path): path is string => Boolean(path) && !excluded.has(path))))
}

export function getPageAssistantContextFiles(
  projectPath: string,
  automaticPagePath: string | null,
  manualContextFiles: string[],
): string[] {
  return getWikiContextFiles(projectPath, automaticPagePath, manualContextFiles)
}

export interface WikiPageAssistantActions {
  selectConversation: (id: string | null) => void
  createConversation: () => void
  addManualContextFile: (path: string) => void
  removeManualContextFile: (path: string) => void
  setWriteMode: (mode: "confirm" | "direct") => void
  openFullChat: () => void
}

export function createWikiPageAssistantActions({
  isStreaming,
  manualContextFiles,
  createConversation,
  setActiveConversation,
  setManualContextFiles,
  setWikiWriteMode,
  setActiveView,
  onOpenFullChat,
}: {
  isStreaming: boolean
  manualContextFiles: string[]
  createConversation: () => string
  setActiveConversation: (id: string | null) => void
  setManualContextFiles: (paths: string[]) => void
  setWikiWriteMode: (mode: "confirm" | "direct") => void
  setActiveView: (view: "chat") => void
  onOpenFullChat?: () => void
}): WikiPageAssistantActions {
  const blocked = () => isStreaming
  return {
    selectConversation: (id) => { if (!blocked()) setActiveConversation(id) },
    createConversation: () => { if (!blocked()) createConversation() },
    addManualContextFile: (path) => { if (!blocked()) setManualContextFiles([...manualContextFiles, path]) },
    removeManualContextFile: (path) => { if (!blocked()) setManualContextFiles(manualContextFiles.filter((item) => item !== path)) },
    setWriteMode: (mode) => { if (!blocked()) setWikiWriteMode(mode) },
    openFullChat: () => {
      if (blocked()) return
      setActiveView("chat")
      onOpenFullChat?.()
    },
  }
}

export function WikiPageAssistant({ automaticPagePath, onClose, onOpenFullChat }: WikiPageAssistantProps) {
  const project = useWikiStore((s) => s.project)
  const projectPathIndex = useWikiStore((s) => s.projectPathIndex)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const createConversation = useChatStore((s) => s.createConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const setManualContextFiles = useChatStore((s) => s.setManualContextFiles)
  const setWikiWriteMode = useChatStore((s) => s.setWikiWriteMode)
  const conversation = conversations.find((item) => item.id === activeConversationId)
  const manualContextFiles = conversation?.manualContextFiles ?? []
  const contextFiles = project
    ? getPageAssistantContextFiles(project.path, automaticPagePath, manualContextFiles)
    : []
  const automaticContextFile = project
    ? getWikiContextFiles(project.path, automaticPagePath, [])[0]
    : undefined
  const writeMode = conversation?.wikiWriteMode ?? "confirm"
  const availablePages = useMemo(
    () => project
      ? getAvailableWikiPageChoices(
        project.path,
        [...projectPathIndex.filesByName.values()].flat(),
        automaticPagePath,
        manualContextFiles,
      )
      : [],
    [automaticPagePath, manualContextFiles, project, projectPathIndex],
  )

  const actions = createWikiPageAssistantActions({
    isStreaming,
    manualContextFiles,
    createConversation,
    setActiveConversation,
    setManualContextFiles,
    setWikiWriteMode,
    setActiveView,
    onOpenFullChat,
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold">Page assistant</span>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="xs" onClick={actions.openFullChat} disabled={isStreaming}>Open full chat</Button>
          <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} disabled={isStreaming} aria-label="Close page assistant">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="shrink-0 space-y-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <select
            aria-label="Conversation"
            value={activeConversationId ?? ""}
            onChange={(event) => actions.selectConversation(event.target.value || null)}
            disabled={isStreaming}
            className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs outline-none disabled:opacity-50"
          >
            <option value="">No conversation</option>
            {conversations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          <Button type="button" variant="outline" size="xs" onClick={actions.createConversation} disabled={isStreaming}>New chat</Button>
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Context pages</div>
          <div className="flex flex-wrap gap-1">
            {automaticContextFile ? (
              <span className="inline-flex items-center gap-1 rounded border bg-muted px-1.5 py-0.5 text-[10px]" title={automaticContextFile}>
                <span className="truncate">{getFileName(automaticContextFile)}</span>
                <span className="rounded bg-primary/15 px-1 text-[9px] text-primary">Automatic</span>
              </span>
            ) : <span className="text-xs text-muted-foreground">No automatic page</span>}
            {contextFiles.filter((path) => path !== automaticContextFile).map((path) => (
              <span key={path} className="inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[10px]" title={path}>
                <span className="truncate">{getFileName(path)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${getFileName(path)}`}
                  disabled={isStreaming}
                  onClick={() => actions.removeManualContextFile(path)}
                  className="rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          {availablePages.length > 0 && (
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <FilePlus2 className="h-3.5 w-3.5" />
              <select
                aria-label="Add wiki page"
                defaultValue=""
                disabled={isStreaming}
                onChange={(event) => {
                  const path = event.target.value
                  if (path) actions.addManualContextFile(path)
                  event.target.value = ""
                }}
                className="min-w-0 flex-1 rounded border bg-background px-1.5 py-1 text-xs outline-none disabled:opacity-50"
              >
                <option value="">Add wiki page</option>
                {availablePages.map((path) => <option key={path} value={path}>{path}</option>)}
              </select>
            </label>
          )}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ChevronDown className="h-3.5 w-3.5" />
          <span className="shrink-0">Write mode</span>
          <select
            aria-label="Write mode"
            value={writeMode}
            onChange={(event) => actions.setWriteMode(event.target.value as "confirm" | "direct")}
            disabled={isStreaming || !activeConversationId}
            className="min-w-0 flex-1 rounded border bg-background px-1.5 py-1 text-xs outline-none disabled:opacity-50"
          >
            <option value="confirm">Confirm every overwrite</option>
            <option value="direct">Direct writes in this conversation</option>
          </select>
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatSessionContent contextFiles={contextFiles} wikiWriteMode={writeMode} />
      </div>
    </div>
  )
}
