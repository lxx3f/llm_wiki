import { useRef, useEffect, useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { BookOpen, MessageSquare, X, Maximize2, FolderOpen, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatMessage, StreamingMessage, useSourceFiles, type ChatReferencePreview } from "./chat-message"
import { ChatInput, type ChatSendOptions } from "./chat-input"
import { ConversationSidebar } from "./conversation-sidebar"
import { cancelPendingWikiWrite, confirmPendingWikiWrite, refreshConfirmedWikiWrite, summarizeConfirmedWikiWrite } from "./wiki-write-confirmation"
import { useChatStore, chatMessagesToLLM, type MessageImage, type MessageReference } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { isReasoningOnlyResponseError, streamChat } from "@/lib/llm-client"
import { supportsImageInput } from "@/lib/llm-providers"
import { executeIngestWrites } from "@/lib/ingest"
import { openPathInProject, readFile } from "@/commands/fs"
import { getFileName, isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { hasConfiguredAnyTxt } from "@/lib/anytxt-search"
import type { ChatAgentEvent, ChatAgentFileChange, ChatAgentStep, ChatMemoryProposal, ChatPendingWikiWrite, ChatSchemaProposal, ChatUserInputRequest } from "@/lib/chat-agent-types"
import type { ChatMessage as LlmChatMessage, ContentBlock } from "@/lib/llm-client"
import { FilePreview } from "@/components/editor/file-preview"
import { WikiReader } from "@/components/editor/wiki-reader"
import { FrontmatterPanel } from "@/components/editor/frontmatter-panel"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getFileCategory, getFileExtension, isTextReadable } from "@/lib/file-types"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { summarizeAgentFileChange } from "@/lib/agent-file-activity"
import { useAutoResolveAnnotations } from "./annotation/useAnnotationActions"

type InternalChatSendOptions = ChatSendOptions & {
  suppressUserMessage?: boolean
  historyOverride?: { role: "user" | "assistant"; content: string }[]
}

interface BackendAgentReference {
  title: string
  path: string
  kind: string
  snippet?: string
  score?: number
  knowledgeContext?: {
    relatedTo?: string[]
    outgoingLinks?: string[]
    backlinks?: string[]
  }
}

interface BackendAgentToolEvent {
  tool: string
  status: string
  detail?: string
  timestamp?: number
}

interface BackendAgentEventPayload {
  sessionId: string
  runId?: string
  event: {
    type: string
    text?: string
    tool?: string
    input?: string
    output?: string
    message?: string
    reference?: BackendAgentReference
    request?: ChatUserInputRequest
    sessionId?: string
    path?: string
    existedBefore?: boolean
    previousContent?: string
    pendingWrite?: ChatPendingWikiWrite
    proposal?: ChatSchemaProposal
    memory?: ChatMemoryProposal
  }
}

interface BackendAgentResponse {
  sessionId: string
  mode?: string
  message: string | { role?: string; content?: string }
  references?: BackendAgentReference[]
  toolEvents?: BackendAgentToolEvent[]
  userInputRequest?: ChatUserInputRequest
  pendingWikiWrite?: ChatPendingWikiWrite
}

interface AvailableAgentSkill {
  id: string
  name: string
  description?: string
  source: string
}

// Store the page mapping from the last query so SourceFilesBar can show which pages were cited
export let lastQueryPages: { title: string; path: string }[] = []

const AGENT_STREAM_IDLE_TIMEOUT_MS = 8 * 60 * 1000
const AGENT_SKILL_STREAM_IDLE_TIMEOUT_MS = 15 * 60 * 1000
const MAX_AGENT_ACTIVITY_SNAPSHOT_CHARS = 512_000

async function readAgentActivitySnapshot(path: string): Promise<string | null> {
  try {
    const content = await readFile(path)
    return content.length <= MAX_AGENT_ACTIVITY_SNAPSHOT_CHARS ? content : null
  } catch {
    return null
  }
}

function parentDirectory(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/g, "")
  const idx = normalized.lastIndexOf("/")
  if (idx <= 0) return normalized
  return normalized.slice(0, idx)
}

function commonDirectory(paths: string[]): string | null {
  const directories = paths
    .map(parentDirectory)
    .filter((dir) => dir.trim().length > 0)
  if (directories.length === 0) return null
  const firstParts = directories[0].split("/")
  let commonLength = firstParts.length
  for (const dir of directories.slice(1)) {
    const parts = dir.split("/")
    commonLength = Math.min(commonLength, parts.length)
    for (let i = 0; i < commonLength; i += 1) {
      if (firstParts[i] !== parts[i]) {
        commonLength = i
        break
      }
    }
  }
  return firstParts.slice(0, commonLength).join("/") || null
}

function agentStreamIdleTimeoutMs(options: ChatSendOptions, skillCount: number): number {
  return skillCount > 0 || options.agentMode === "deep"
    ? AGENT_SKILL_STREAM_IDLE_TIMEOUT_MS
    : AGENT_STREAM_IDLE_TIMEOUT_MS
}

function backendReferenceToMessageReference(ref: BackendAgentReference): MessageReference {
  const isWiki = ref.kind === "wiki" || ref.path.startsWith("wiki/")
  const isWeb = ref.kind === "web" || /^https?:\/\//i.test(ref.path)
  const isWorkspace = ref.kind === "workspace" || ref.path.startsWith("agent-workspace/")
  const source =
    isWorkspace ? "Workspace"
      : ref.kind === "anytxt" ? "AnyTXT"
      : ref.kind === "web" ? "Web"
        : ref.kind === "source" ? "Source"
          : ref.kind === "graph" ? "Graph"
            : undefined
  return {
    title: ref.title,
    path: ref.path,
    kind: isWiki ? "wiki" : isWorkspace ? "workspace" : "external",
    source,
    url: isWeb ? ref.path : undefined,
    snippet: ref.snippet,
    graphRelations: ref.knowledgeContext?.relatedTo,
  }
}

function projectAbsolutePath(projectPath: string, path: string): string {
  const pp = normalizePath(projectPath)
  const normalized = normalizePath(path)
  if (normalized.startsWith(`${pp}/`)) return normalized
  if (isAbsolutePath(normalized)) return normalized
  return `${pp}/${normalized.replace(/^\/+/, "")}`
}

function isAgentWorkspacePath(filePath: string): boolean {
  return normalizePath(filePath).split("/").includes("agent-workspace")
}

function isGeneratedOutputImage(filePath: string): boolean {
  const category = getFileCategory(filePath)
  return category === "image" || (getFileExtension(filePath) === "svg" && isAgentWorkspacePath(filePath))
}

function backendToolToAgentStep(event: BackendAgentToolEvent, index: number) {
  if (event.tool === "agent.plan_tools") {
    return {
      id: `backend-${index}-${event.tool}-${event.status}`,
      type: "routing" as const,
      message: event.detail ?? event.tool,
      status: event.status === "failed" ? "error" as const : "success" as const,
      timestamp: event.timestamp,
    }
  }
  if (event.tool === "llm.generate") {
    return {
      id: `backend-${index}-${event.tool}-${event.status}`,
      type: "final" as const,
      message: event.detail ?? event.tool,
      status: event.status === "failed" ? "error" as const
        : event.status === "started" ? "running" as const
          : "success" as const,
      timestamp: event.timestamp,
    }
  }
  const tool = normalizeBackendToolName(event.tool)
  // Preserve input/output separately so the persisted row, when later
  // surfaced by SavedAgentActivity, can also expand.
  const isStart = event.status === "started"
  return {
    id: `backend-${index}-${event.tool}-${event.status}`,
    type: event.status === "started" ? "tool_call" as const : "tool_result" as const,
    tool,
    toolRaw: event.tool,
    message: event.detail ?? event.tool,
    status: event.status === "failed" ? "error" as const
      : event.status === "available" ? "skipped" as const
        : event.status === "started" ? "running" as const
          : "success" as const,
    timestamp: event.timestamp,
    input: isStart ? event.detail : undefined,
    output: !isStart ? event.detail : undefined,
  }
}

function normalizeBackendToolName(tool: string) {
  const normalized = tool.split(".").join("_")
  if (normalized === "wiki_search") return "wiki_search" as const
  if (normalized === "wiki_read_page") return "project_file_read" as const
  if (normalized === "wiki_write_page") return "project_files" as const
  if (normalized === "wiki_edit_page") return "project_files" as const
  if (normalized === "workspace_write_file") return "project_files" as const
  if (normalized === "workspace_append_file") return "project_files" as const
  if (normalized === "workspace_read_file") return "project_file_read" as const
  if (normalized === "workspace_edit_file") return "project_files" as const
  if (normalized === "skills_load") return "project_file_read" as const
  if (normalized === "context_attach") return "project_file_read" as const
  if (normalized === "skill_read_file") return "project_file_read" as const
  if (normalized === "source_search") return "project_file_read" as const
  if (normalized === "graph_search") return "graph_search" as const
  if (normalized === "web_search") return "web_search" as const
  if (normalized === "anytxt_search") return "anytxt_search" as const
  if (normalized === "shell_exec") return "shell_exec" as const
  if (normalized === "deep_research_run") return "project_file_read" as const
  return "unknown_tool" as const
}

function backendToolToAgentEvent(event: BackendAgentToolEvent): ChatAgentEvent {
  if (event.tool === "agent.plan_tools") {
    return {
      stage: "routing",
      message: event.detail ?? event.tool,
      status: event.status === "failed" ? "error" : "success",
      timestamp: event.timestamp,
    }
  }
  if (event.tool === "llm.generate") {
    return {
      stage: "writing",
      message: event.detail ?? event.tool,
      status: event.status === "failed" ? "error"
        : event.status === "started" ? "running"
          : "success",
      timestamp: event.timestamp,
    }
  }
  const tool = normalizeBackendToolName(event.tool)
  const stage =
    tool === "web_search" ? "searching_web"
      : tool === "anytxt_search" ? "searching_anytxt"
        : tool === "graph_search" ? "searching_graph"
          : tool === "project_file_read" ? "reading_context"
            : tool === "wiki_search" ? "searching_wiki"
              : event.status === "started" ? "tool_call"
                : "tool_result"
  // toolStart events carry the agent's input payload (path / query / command
  // / …); toolEnd events carry the agent's output summary. We preserve
  // them as separate fields on the UI event so the activity row's
  // click-to-expand panel can render them verbatim. The renderer is
  // responsible for merging start + end into a single row.
  const isStart = event.status === "started"
  return {
    stage,
    tool,
    // Preserve the original backend tool id so the UI can show
    // "wiki.read_page" / "shell.exec" / "mcp.minimax.search" exactly as
    // named in the agent's tool list, not just the 8-category enum.
    toolRaw: event.tool,
    message: event.detail ?? event.tool,
    status: event.status === "failed" ? "error"
      : event.status === "started" ? "running"
        : event.status === "available" ? "skipped"
          : "success",
    timestamp: event.timestamp,
    input: isStart ? event.detail : undefined,
    output: !isStart ? event.detail : undefined,
  }
}

function backendResponseText(response: BackendAgentResponse): string {
  if (typeof response.message === "string") return response.message
  return response.message?.content ?? ""
}

function enabledSkillIds(skills: AvailableAgentSkill[], disabledSkills: string[]): Set<string> {
  const disabled = new Set(disabledSkills)
  return new Set(skills.filter((skill) => !disabled.has(skill.id)).map((skill) => skill.id))
}

function summarizeAgentStepsForResume(steps: ChatAgentStep[] = []): string {
  const lines = steps
    .filter((step) => step.message?.trim())
    .slice(-12)
    .map((step) => {
      const label = step.tool ?? step.type
      const status = step.status ?? "success"
      return `- ${label} ${status}: ${step.message?.trim()}`
    })
  return lines.length > 0 ? lines.join("\n") : "- No prior tool observations were saved."
}

function compactChatHistoryForResume(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  maxMessages: number,
): { role: "user" | "assistant"; content: string }[] {
  return messages
    .filter((message): message is { role: "user" | "assistant"; content: string } =>
      message.role === "user" || message.role === "assistant"
    )
    .slice(-maxMessages)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }))
}

function conversationMessages(conversationId: string) {
  return useChatStore.getState().messages.filter((message) => message.conversationId === conversationId)
}

export interface ChatSessionContentProps {
  contextFiles: string[]
  showConversationControls?: boolean
  wikiWriteMode?: "confirm" | "direct"
  onConfirmedWrite?: () => void
}

export function ChatSessionContent({ contextFiles, showConversationControls = false, wikiWriteMode = "confirm", onConfirmedWrite }: ChatSessionContentProps) {
  const { t } = useTranslation()
  // Mount the auto-resolve timer at the top level so it lives as long as the
  // chat session content is on screen. The hook returns nothing and uses an
  // empty-deps effect that is cleared on unmount, so it has zero render cost.
  useAutoResolveAnnotations()
  useSourceFiles() // Keep source file cache warm
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const streamingContent = useChatStore((s) => s.streamingContent)
  const mode = useChatStore((s) => s.mode)
  const addMessageToConversation = useChatStore((s) => s.addMessageToConversation)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const appendStreamToken = useChatStore((s) => s.appendStreamToken)
  const finalizeStreamForConversation = useChatStore((s) => s.finalizeStreamForConversation)
  const createConversation = useChatStore((s) => s.createConversation)
  const removeLastAssistantMessage = useChatStore((s) => s.removeLastAssistantMessage)
  const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages)
  const useWebSearch = useChatStore((s) => s.useWebSearch)
  const useAnyTxtSearch = useChatStore((s) => s.useAnyTxtSearch)
  const agentMode = useChatStore((s) => s.agentMode)
  const retrievalMode = useChatStore((s) => s.retrievalMode)
  const selectedSkills = useChatStore((s) => s.selectedSkills)
  const selectedContextFiles = contextFiles
  const disabledSkills = useChatStore((s) => s.disabledSkills)
  const setUseWebSearch = useChatStore((s) => s.setUseWebSearch)
  const setUseAnyTxtSearch = useChatStore((s) => s.setUseAnyTxtSearch)
  const setAgentMode = useChatStore((s) => s.setAgentMode)
  const setRetrievalMode = useChatStore((s) => s.setRetrievalMode)
  const setSelectedSkills = useChatStore((s) => s.setSelectedSkills)
  const setSelectedContextFiles = useChatStore((s) => s.setSelectedContextFiles)

  // Derive active messages via selector to re-render on message changes
  const allMessages = useChatStore((s) => s.messages)
  const activeMessages = activeConversationId
    ? allMessages.filter((m) => m.conversationId === activeConversationId)
    : []

  const project = useWikiStore((s) => s.project)
  const projectPathIndex = useWikiStore((s) => s.projectPathIndex)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const enhancedShellMode = useWikiStore((s) => s.enhancedShellMode)
  const anyTxtAvailable = hasConfiguredAnyTxt(searchApiConfig.anyTxt)
  const imageInputAvailable = supportsImageInput(llmConfig)
  const availableContextFiles = useMemo(() => {
    if (!project) return []
    const root = normalizePath(project.path).replace(/\/+$/g, "")
    const files = [...projectPathIndex.filesByName.values()].flat()
    return [...new Set(files
      .map((entry) => normalizePath(entry.path))
      .filter((path) => path.startsWith(`${root}/`))
      .map((path) => path.slice(root.length + 1))
      .filter((path) => !path.split("/").some((segment) => segment.startsWith("."))))]
      .sort((left, right) => left.localeCompare(right))
  }, [project, projectPathIndex])

  const abortRef = useRef<AbortController | null>(null)
  const activeRunSessionIdRef = useRef<string | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const runIdRef = useRef(0)
  const dismissedGeneratedOutputsKeyRef = useRef<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [agentEvents, setAgentEvents] = useState<ChatAgentEvent[]>([])
  const [referencePreview, setReferencePreview] = useState<ChatReferencePreview | null>(null)
  // True once the user has dismissed (or acknowledged) the Enhanced shell
  // banner for the active conversation. Reset to false whenever the user
  // switches to a different conversation so a fresh session can show the
  // banner again the first time it invokes `shell.exec`.
  const [enhancedShellBannerDismissed, setEnhancedShellBannerDismissed] = useState(false)
  // Tracks whether the banner has been surfaced for the current
  // conversation. Set true the first time `shell.exec` runs under
  // `enhancedShellMode`; persisted only for the lifetime of this component.
  const [enhancedShellBannerShownForConv, setEnhancedShellBannerShownForConv] = useState(false)
  const [generatedOutputPreviews, setGeneratedOutputPreviews] = useState<ChatReferencePreview[]>([])
  const [generatedOutputPreview, setGeneratedOutputPreview] = useState<ChatReferencePreview | null>(null)
  const [referencePreviewWidth, setReferencePreviewWidth] = useState(420)
  const [availableSkills, setAvailableSkills] = useState<AvailableAgentSkill[]>([])
  const [approvingShellMessageId, setApprovingShellMessageId] = useState<string | null>(null)
  const buildGeneratedOutputPreview = useCallback(async (ref: MessageReference): Promise<ChatReferencePreview | null> => {
    if (!project) return null
    const outputPath = projectAbsolutePath(project.path, ref.path)
    try {
      const category = getFileCategory(outputPath)
      const shouldReadContent = isTextReadable(category) || category === "pdf"
      const content = shouldReadContent ? await readFile(outputPath) : ""
      return {
        title: ref.title || getFileName(outputPath),
        path: outputPath,
        source: ref.source ?? "Workspace",
        content,
        snippet: ref.snippet,
      }
    } catch (err) {
      console.warn("[chat] failed to auto-open generated output:", err)
      return {
        title: ref.title || getFileName(outputPath),
        path: outputPath,
        source: ref.source ?? "Workspace",
        content: `Unable to load generated file: ${ref.path}`,
        snippet: ref.snippet,
      }
    }
  }, [project])
  const autoOpenSingleGeneratedOutput = useCallback((conversationId: string, references?: MessageReference[]) => {
    if (useChatStore.getState().activeConversationId !== conversationId) return
    const outputs = (references ?? []).filter((ref) => ref.kind === "workspace")
    if (outputs.length === 0 || !project) return
    const previews = outputs.map((ref) => {
      const outputPath = projectAbsolutePath(project.path, ref.path)
      return {
        title: ref.title || getFileName(outputPath),
        path: outputPath,
        source: ref.source ?? "Workspace",
        content: "",
        snippet: ref.snippet,
      }
    })
    setReferencePreview(null)
    setGeneratedOutputPreviews(previews)
    if (outputs.length === 1) {
      void buildGeneratedOutputPreview(outputs[0]).then((preview) => {
        if (preview) {
          setGeneratedOutputPreviews([preview])
          setGeneratedOutputPreview(preview)
        }
      })
    }
  }, [buildGeneratedOutputPreview, project])
  const activeStreaming = Boolean(isStreaming && activeConversationId)
  const activeAgentEvents = activeStreaming ? agentEvents : []
  const lastMessage = activeMessages[activeMessages.length - 1]
  const latestGeneratedOutputMessage = [...activeMessages]
    .reverse()
    .find((message) =>
      message.role === "assistant"
      && (message.references ?? []).some((ref) => ref.kind === "workspace")
    )
  const scrollKey = [
    activeConversationId ?? "",
    activeMessages.length,
    lastMessage?.id ?? "",
    lastMessage?.content.length ?? 0,
    activeStreaming ? streamingContent.length : 0,
  ].join(":")

  // Auto-scroll to bottom when messages change or streaming content updates
  useEffect(() => {
    const container = scrollContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [scrollKey])

  useEffect(() => {
    setReferencePreview(null)
    setGeneratedOutputPreviews([])
    setGeneratedOutputPreview(null)
    dismissedGeneratedOutputsKeyRef.current = null
    // Reset the per-conversation Enhanced shell banner so a new session can
    // surface it once on its first `shell.exec` invocation.
    setEnhancedShellBannerDismissed(false)
    setEnhancedShellBannerShownForConv(false)
  }, [activeConversationId])

  useEffect(() => {
    if (!project || activeStreaming || !latestGeneratedOutputMessage) return
    const outputs = (latestGeneratedOutputMessage.references ?? []).filter((ref) => ref.kind === "workspace")
    if (outputs.length === 0) return
    const previews = outputs.map((ref) => {
      const outputPath = projectAbsolutePath(project.path, ref.path)
      return {
        title: ref.title || getFileName(outputPath),
        path: outputPath,
        source: ref.source ?? "Workspace",
        content: "",
        snippet: ref.snippet,
      }
    })
    const currentKey = generatedOutputPreviews.map((preview) => preview.path).join("\n")
    const nextKey = previews.map((preview) => preview.path).join("\n")
    const scopedNextKey = `${activeConversationId ?? ""}:${nextKey}`
    if (dismissedGeneratedOutputsKeyRef.current === scopedNextKey) return
    if (currentKey === nextKey) return
    setReferencePreview(null)
    setGeneratedOutputPreviews(previews)
  }, [activeConversationId, activeStreaming, generatedOutputPreviews, latestGeneratedOutputMessage, project])

  const loadGeneratedOutputPreview = useCallback(async (preview: ChatReferencePreview): Promise<ChatReferencePreview> => {
    const category = getFileCategory(preview.path)
    const shouldReadContent = isTextReadable(category) || category === "pdf"
    if (!shouldReadContent || preview.content) return preview
    try {
      return {
        ...preview,
        content: await readFile(preview.path),
      }
    } catch {
      return preview
    }
  }, [])

  const openGeneratedOutputModal = useCallback((preview: ChatReferencePreview) => {
    void loadGeneratedOutputPreview(preview).then(setGeneratedOutputPreview)
  }, [loadGeneratedOutputPreview])

  const closeGeneratedOutputsPanel = useCallback(() => {
    const currentKey = generatedOutputPreviews.map((preview) => preview.path).join("\n")
    dismissedGeneratedOutputsKeyRef.current = `${activeConversationId ?? ""}:${currentKey}`
    setGeneratedOutputPreviews([])
    setGeneratedOutputPreview(null)
  }, [activeConversationId, generatedOutputPreviews])

  const openGeneratedOutputDirectory = useCallback(() => {
    if (!project) return
    const directory = commonDirectory(generatedOutputPreviews.map((preview) => preview.path))
    if (!directory) return
    void openPathInProject(project.path, directory).catch((err) => {
      console.error("[chat] failed to open generated output directory:", err)
    })
  }, [generatedOutputPreviews, project])

  const handleOpenReferencePreview = useCallback((preview: ChatReferencePreview, relatedPreviews?: ChatReferencePreview[]) => {
    const isGeneratedOutput = preview.source === "Workspace"
      || normalizePath(preview.path).split("/").includes("agent-workspace")
    if (!isGeneratedOutput) {
      setGeneratedOutputPreviews([])
      setGeneratedOutputPreview(null)
      setReferencePreview(preview)
      return
    }
    const previews = relatedPreviews && relatedPreviews.length > 0
      ? relatedPreviews.map((item) =>
          item.path === preview.path
            ? { ...item, content: preview.content }
            : item
        )
      : [preview]
    setReferencePreview(null)
    setGeneratedOutputPreviews(previews)
    openGeneratedOutputModal(preview)
  }, [openGeneratedOutputModal])

  useEffect(() => {
    let cancelled = false
    if (!project?.path) {
      setAvailableSkills([])
      return
    }
    invoke<AvailableAgentSkill[]>("agent_list_skills", { projectPath: project.path })
      .then((skills) => {
        if (cancelled) return
        const enabled = enabledSkillIds(skills, useChatStore.getState().disabledSkills)
        const enabledSkills = skills.filter((skill) => enabled.has(skill.id))
        setAvailableSkills(enabledSkills)
        const current = useChatStore.getState().selectedSkills
        const filtered = current.filter((name) => enabled.has(name))
        if (filtered.length !== current.length) {
          setSelectedSkills(filtered)
        }
      })
      .catch(() => {
        if (!cancelled) setAvailableSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [project?.path, disabledSkills, setSelectedSkills])

  const handleSend = useCallback(
    async (
      text: string,
      images: MessageImage[] = [],
      options?: InternalChatSendOptions,
    ) => {
      if (useChatStore.getState().isStreaming) return
      const sendOptions = {
        ...(options ?? {
          useWebSearch: useChatStore.getState().useWebSearch,
          useAnyTxtSearch: useChatStore.getState().useAnyTxtSearch,
          agentMode: useChatStore.getState().agentMode,
          retrievalMode: useChatStore.getState().retrievalMode,
          skills: useChatStore.getState().selectedSkills,
          contextFiles,
          skillMode: useChatStore.getState().selectedSkills.length > 0 ? "explicit" : "auto",
        }),
        wikiWriteMode: options?.wikiWriteMode ?? wikiWriteMode,
      }
      const allowedSkills = enabledSkillIds(
        availableSkills,
        useChatStore.getState().disabledSkills,
      )
      const requestedSkillMode = sendOptions.skillMode ?? (
        sendOptions.skills.length > 0 ? "explicit" : "auto"
      )
      const requestSkills = requestedSkillMode === "auto" && sendOptions.skills.length === 0
        ? Array.from(allowedSkills)
        : sendOptions.skills.filter((id) => allowedSkills.has(id))
      // Auto-create a conversation if none is active
      let convId = useChatStore.getState().activeConversationId
      if (!convId) {
        convId = createConversation()
      }

      if (!sendOptions.suppressUserMessage) {
        const messageContextFiles = project
          ? sendOptions.contextFiles.map((path) => projectAbsolutePath(project.path, path))
          : []
        addMessageToConversation(convId, "user", text, images, messageContextFiles)
      }
      setStreaming(true)
      setAgentEvents([])
      let finalized = false
      const runId = ++runIdRef.current
      const backendRunId = `ui-${Date.now()}-${runId}`

      try {
        const controller = new AbortController()
        abortRef.current = controller
        activeRunSessionIdRef.current = convId
        activeRunIdRef.current = backendRunId
        const isCurrentRun = () => runIdRef.current === runId && !controller.signal.aborted

        const useBackendAgent =
          llmConfig.provider !== "claude-code" &&
          llmConfig.provider !== "codex-cli"

        if (useBackendAgent) {
          setAgentEvents([
            {
              stage: "routing",
              status: "running",
              message: t("chat.agent.routing"),
            },
          ])
          const visibleHistory = conversationMessages(convId)
            .filter((m) => m.role === "user" || m.role === "assistant")
          const activeConvMessages = sendOptions.historyOverride
            ?? (sendOptions.suppressUserMessage ? visibleHistory : visibleHistory.slice(0, -1))
              .slice(-maxHistoryMessages)
              .map((m) => ({ role: m.role, content: m.content }))
          let accumulated = ""
          const references: MessageReference[] = []
          let pendingWikiWrite: ChatPendingWikiWrite | undefined
          let pendingSchemaProposal: ChatSchemaProposal | undefined
          let pendingMemoryProposal: ChatMemoryProposal | undefined
          const backendEvents: BackendAgentToolEvent[] = []
          const fileChanges = new Map<string, ChatAgentFileChange>()
          const fileEditChanges: ChatAgentFileChange[] = []
          let fileEditSequence = 0
          const fileEditOrder = new Map<string, number>()
          const trackedFilePaths = new Set<string>()
          const fileActivityTasks: Promise<void>[] = []
          const fileActivityChains = new Map<string, Promise<void>>()
          const seenRefs = new Set<string>()
          let pendingUserInputRequest: ChatUserInputRequest | undefined
          let streamFinished = false
          let streamUnlisten: (() => void) | null = null
          let resolveStream: (() => void) | null = null
          let rejectStream: ((err: Error) => void) | null = null
          const streamDone = new Promise<void>((resolve, reject) => {
            resolveStream = resolve
            rejectStream = reject
          })
          void streamDone.catch(() => {})
          const streamIdleTimeoutMs = agentStreamIdleTimeoutMs(sendOptions, requestSkills.length)
          let timeout: number | undefined
          const clearStreamTimeout = () => {
            if (timeout !== undefined) {
              window.clearTimeout(timeout)
              timeout = undefined
            }
          }
          const resetStreamTimeout = () => {
            clearStreamTimeout()
            timeout = window.setTimeout(() => {
              if (!streamFinished) {
                streamFinished = true
                rejectStream?.(new Error("Agent stream timed out"))
              }
            }, streamIdleTimeoutMs)
          }
          resetStreamTimeout()
          streamUnlisten = await listen<BackendAgentEventPayload>("agent-event", (event) => {
            const payload = event.payload
            if (payload.sessionId !== convId || payload.runId !== backendRunId || !isCurrentRun()) return
            resetStreamTimeout()
            const agentEvent = payload.event
            if (agentEvent.type === "done") {
              if (!streamFinished) {
                streamFinished = true
                clearStreamTimeout()
                resolveStream?.()
              }
              return
            }
            if (agentEvent.type === "wikiWriteConfirmationRequired" && agentEvent.pendingWrite) {
              pendingWikiWrite = agentEvent.pendingWrite
              return
            }
            if (agentEvent.type === "schemaProposalConfirmationRequired" && agentEvent.proposal) {
              pendingSchemaProposal = agentEvent.proposal
              return
            }
            if (agentEvent.type === "memoryProposalConfirmationRequired" && agentEvent.memory) {
              pendingMemoryProposal = agentEvent.memory
              return
            }
            if (agentEvent.type === "messageDelta" && agentEvent.text) {
              accumulated += agentEvent.text
              appendStreamToken(agentEvent.text)
              return
            }
            if (agentEvent.type === "referenceAdded" && agentEvent.reference) {
              const ref = backendReferenceToMessageReference(agentEvent.reference)
              const key = `${ref.kind ?? "wiki"}:${ref.url ?? ref.path}`.toLowerCase()
              if (!seenRefs.has(key)) {
                seenRefs.add(key)
                references.push(ref)
              }
              if (ref.kind === "workspace" && project) {
                const outputPath = projectAbsolutePath(project.path, ref.path)
                const preview: ChatReferencePreview = {
                  title: ref.title || getFileName(outputPath),
                  path: outputPath,
                  source: ref.source ?? "Workspace",
                  content: "",
                  snippet: ref.snippet,
                }
                dismissedGeneratedOutputsKeyRef.current = null
                setReferencePreview(null)
                setGeneratedOutputPreviews((prev) => {
                  if (prev.some((item) => item.path === preview.path)) return prev
                  return [...prev, preview]
                })
                if (!trackedFilePaths.has(outputPath) && !fileChanges.has(outputPath)) {
                  const editSequence = ++fileEditSequence
                  const editId = `${backendRunId}:${outputPath}:${editSequence}`
                  const editTimestamp = Date.now()
                  fileEditOrder.set(editId, editSequence)
                  const task = readAgentActivitySnapshot(outputPath).then((afterContent) => {
                    if (afterContent === null) return
                    const change = summarizeAgentFileChange({
                      id: editId,
                      path: outputPath,
                      tool: "shell.exec",
                      // Shell can create or replace multiple files, but it cannot
                      // provide an atomic pre-write snapshot. Never guess that an
                      // observed file is new because Undo could delete user data.
                      beforeContent: "",
                      afterContent,
                      timestamp: editTimestamp,
                    })
                    change.operation = "modified"
                    change.additions = 0
                    change.deletions = 0
                    change.diff = t("chat.agentChanges.shellSnapshotUnavailable")
                    change.beforeContent = undefined
                    change.afterContent = undefined
                    fileChanges.set(outputPath, change)
                    fileEditChanges.push(change)
                  })
                  fileActivityTasks.push(task)
                }
              }
              return
            }
            if (agentEvent.type === "fileChanged" && project && agentEvent.path && agentEvent.tool) {
              const filePath = projectAbsolutePath(project.path, agentEvent.path)
              const editSequence = ++fileEditSequence
              const editId = `${backendRunId}:${filePath}:${editSequence}`
              const editTimestamp = Date.now()
              fileEditOrder.set(editId, editSequence)
              trackedFilePaths.add(filePath)
              const previousTask = fileActivityChains.get(filePath) ?? Promise.resolve()
              const task = previousTask.then(async () => {
                const afterContent = await readAgentActivitySnapshot(filePath)
                if (afterContent === null) return
                const originalBefore = agentEvent.existedBefore ? agentEvent.previousContent : null
                const beforeKnown = !agentEvent.existedBefore || typeof originalBefore === "string"
                const change = summarizeAgentFileChange({
                  id: editId,
                  path: filePath,
                  tool: agentEvent.tool!,
                  beforeContent: beforeKnown ? (originalBefore ?? null) : "",
                  afterContent,
                  timestamp: editTimestamp,
                })
                if (!beforeKnown) {
                  change.operation = "modified"
                  change.additions = 0
                  change.deletions = 0
                  change.diff = t("chat.agentChanges.diffUnavailable")
                  change.beforeContent = undefined
                  change.afterContent = undefined
                }
                fileChanges.set(filePath, change)
                fileEditChanges.push(change)
              })
              fileActivityChains.set(filePath, task)
              fileActivityTasks.push(task)
              return
            }
            if (agentEvent.type === "userInputRequired" && agentEvent.request) {
              pendingUserInputRequest = agentEvent.request
              if (!accumulated.trim()) {
                const intro = agentEvent.request.description
                  || t("chat.userInputRequiredDescription", { defaultValue: "Please provide the requested information to continue." })
                accumulated = intro
                appendStreamToken(intro)
              }
              return
            }
            if (agentEvent.type === "toolStart" && agentEvent.tool) {
              const toolEvent: BackendAgentToolEvent = {
                tool: agentEvent.tool,
                status: "started",
                detail: agentEvent.input,
                timestamp: Date.now(),
              }
              backendEvents.push(toolEvent)
              setAgentEvents((prev) => [...prev, backendToolToAgentEvent(toolEvent)].slice(-6))
              // Surface the Enhanced shell banner exactly once per
              // conversation, the first time the agent actually runs
              // `shell.exec` (not on every toolStart of every tool). The
              // banner is purely informational — it does not block the run.
              if (
                agentEvent.tool === "shell.exec" &&
                useWikiStore.getState().enhancedShellMode
              ) {
                setEnhancedShellBannerShownForConv(true)
              }
              return
            }
            if (agentEvent.type === "toolEnd" && agentEvent.tool) {
              const failed = typeof agentEvent.output === "string" && agentEvent.output.startsWith("failed:")
              const skipped = typeof agentEvent.output === "string" && agentEvent.output.startsWith("approval required:")
              const toolEvent: BackendAgentToolEvent = {
                tool: agentEvent.tool,
                status: failed ? "failed" : skipped ? "available" : "completed",
                detail: agentEvent.output,
                timestamp: Date.now(),
              }
              backendEvents.push(toolEvent)
              setAgentEvents((prev) => [...prev, backendToolToAgentEvent(toolEvent)].slice(-6))
              return
            }
            if (agentEvent.type === "error" && agentEvent.message) {
              const toolEvent: BackendAgentToolEvent = {
                tool: "agent",
                status: "failed",
                detail: agentEvent.message,
                timestamp: Date.now(),
              }
              backendEvents.push(toolEvent)
              setAgentEvents((prev) => [...prev, backendToolToAgentEvent(toolEvent)].slice(-6))
              if (!streamFinished) {
                streamFinished = true
                clearStreamTimeout()
                rejectStream?.(new Error(agentEvent.message))
              }
            }
          })
          try {
            await invoke<string>("agent_start_turn_stream", {
              projectId: project?.id ?? "current",
              request: {
                message: text,
                sessionId: convId,
                runId: backendRunId,
                mode: sendOptions.agentMode,
                retrievalMode: sendOptions.retrievalMode,
                stream: true,
                tools: {
                  wiki: true,
                  web: sendOptions.useWebSearch,
                  anytxt: sendOptions.useAnyTxtSearch,
                },
                topK: sendOptions.agentMode === "deep" ? 8 : 5,
                includeContent: sendOptions.agentMode === "deep",
                history: activeConvMessages,
                historyExplicit: true,
                skills: requestSkills,
                contextFiles: sendOptions.contextFiles,
                wikiWriteMode: sendOptions.wikiWriteMode ?? "confirm",
                skillMode: requestedSkillMode,
                approvedShellCommands: sendOptions.approvedShellCommands ?? [],
                shellCommand: sendOptions.shellCommand,
                allowUnlimitedIterations: sendOptions.allowUnlimitedIterations ?? false,
                images: images.map((image) => ({
                  mediaType: image.mediaType,
                  dataBase64: image.dataBase64,
                })),
              },
            })
            await streamDone
            await Promise.allSettled(fileActivityTasks)
            fileEditChanges.sort(
              (left, right) => (fileEditOrder.get(left.id) ?? 0) - (fileEditOrder.get(right.id) ?? 0),
            )
          } finally {
            clearStreamTimeout()
            streamUnlisten?.()
          }
          if (!isCurrentRun()) return
          lastQueryPages = references
            .filter((ref) => ref.kind === "wiki")
            .map((ref) => ({ title: ref.title, path: ref.path }))
          const steps = backendEvents.map(backendToolToAgentStep)
          finalized = true
          finalizeStreamForConversation(
            convId,
            accumulated,
            references,
            steps,
            pendingUserInputRequest,
            fileEditChanges,
          )
          if (pendingWikiWrite) addPendingWikiWriteToMessage(convId, pendingWikiWrite)
          if (pendingSchemaProposal) addPendingSchemaProposalToMessage(convId, pendingSchemaProposal)
          if (pendingMemoryProposal) addPendingMemoryProposalToMessage(convId, pendingMemoryProposal)
          if (!pendingUserInputRequest) {
            autoOpenSingleGeneratedOutput(convId, references)
          }
          setAgentEvents([])
          abortRef.current = null
          activeRunSessionIdRef.current = null
          activeRunIdRef.current = null
          return
        }

        const activeConvMessages = conversationMessages(convId)
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-maxHistoryMessages)
        const priorMessages = activeConvMessages.slice(0, -1)
        const priorWireMessages = sendOptions.historyOverride
          ?? chatMessagesToLLM(priorMessages).map((m) => ({
            role: m.role,
            content: typeof m.content === "string"
              ? m.content
              : m.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
          }))
        const backendResponse = await invoke<BackendAgentResponse>("agent_start_turn", {
          projectId: project?.id ?? "current",
          request: {
            message: text,
            sessionId: convId,
            runId: backendRunId,
            persistSession: false,
            mode: sendOptions.agentMode,
            retrievalMode: sendOptions.retrievalMode,
            tools: {
              wiki: true,
              web: sendOptions.useWebSearch,
              anytxt: sendOptions.useAnyTxtSearch,
            },
            topK: sendOptions.agentMode === "deep" ? 8 : 5,
            includeContent: sendOptions.agentMode === "deep",
            skills: requestSkills,
            contextFiles: sendOptions.contextFiles,
            wikiWriteMode: sendOptions.wikiWriteMode ?? "confirm",
            skillMode: requestedSkillMode,
            historyExplicit: true,
            approvedShellCommands: sendOptions.approvedShellCommands ?? [],
            shellCommand: sendOptions.shellCommand,
            allowUnlimitedIterations: sendOptions.allowUnlimitedIterations ?? false,
            history: priorWireMessages,
            images: images.map((image) => ({
              mediaType: image.mediaType,
              dataBase64: image.dataBase64,
            })),
          },
        })
        if (!isCurrentRun()) return

        const pendingWikiWrite = backendResponse.pendingWikiWrite
        const backendReferences = (backendResponse.references ?? []).map(backendReferenceToMessageReference)
        const backendSteps = (backendResponse.toolEvents ?? []).map(backendToolToAgentStep)
        const backendEvents = (backendResponse.toolEvents ?? []).map(backendToolToAgentEvent)
        setAgentEvents(backendEvents.slice(-6))
        lastQueryPages = backendReferences
          .filter((ref) => ref.kind === "wiki")
          .map((ref) => ({ title: ref.title, path: ref.path }))

        if (backendResponse.userInputRequest) {
          finalized = true
          finalizeStreamForConversation(
            convId,
            backendResponse.message
              ? backendResponseText(backendResponse)
              : (backendResponse.userInputRequest.description ?? t("chat.userInputRequiredDescription", { defaultValue: "Please provide the requested information to continue." })),
            backendReferences,
            backendSteps,
            backendResponse.userInputRequest,
          )
          setAgentEvents([])
          abortRef.current = null
          activeRunSessionIdRef.current = null
          activeRunIdRef.current = null
          return
        }

        const contextText = [
          "You have access to the current LLM Wiki project context below. Use it as retrieved evidence when it is relevant.",
          "",
          backendResponseText(backendResponse),
          "",
          `User request: ${text}`,
        ].join("\n")
        const userContent: string | ContentBlock[] = images.length > 0
          ? [
              { type: "text", text: contextText },
              ...images.map((image) => ({
                type: "image" as const,
                mediaType: image.mediaType,
                dataBase64: image.dataBase64,
              })),
            ]
          : contextText
        const finalMessages: LlmChatMessage[] = [
          {
            role: "system",
            content: "Answer using the provided LLM Wiki context and references. If the context is insufficient, say what is missing instead of inventing details.",
          },
          ...(sendOptions.historyOverride ?? chatMessagesToLLM(priorMessages)),
          { role: "user", content: userContent },
        ]

        let accumulated = ""
        let thinkingOpen = false

        const appendReasoning = (token: string) => {
          if (!token) return
          if (!thinkingOpen) {
            thinkingOpen = true
            accumulated += "<think>"
            appendStreamToken("<think>")
          }
          accumulated += token
          appendStreamToken(token)
        }

        const closeReasoning = () => {
          if (!thinkingOpen) return
          thinkingOpen = false
          accumulated += "</think>"
          appendStreamToken("</think>")
        }

        const streamFinalAnswer = async (reasoningOff: boolean) => {
          let streamError: Error | null = null
          await streamChat(
            llmConfig,
            finalMessages,
            {
              onToken: (token) => {
                if (!isCurrentRun()) return
                closeReasoning()
                accumulated += token
                appendStreamToken(token)
              },
              onReasoningToken: (token) => {
                if (!isCurrentRun()) return
                if (reasoningOff) return
                appendReasoning(token)
              },
              onDone: () => {},
              onError: (err) => {
                streamError = err
              },
            },
            controller.signal,
            reasoningOff ? { reasoning: { mode: "off" } } : undefined,
          )
          if (streamError) throw streamError
        }

        try {
          await streamFinalAnswer(false)
        } catch (err) {
          if (!isCurrentRun()) return
          if (isReasoningOnlyResponseError(err)) {
            accumulated = ""
            thinkingOpen = false
            useChatStore.setState({ streamingContent: "" })
            await streamFinalAnswer(true)
          } else {
            throw err
          }
        }

        if (!isCurrentRun()) return
        closeReasoning()
        finalized = true
        finalizeStreamForConversation(convId, accumulated, backendReferences, backendSteps)
        if (pendingWikiWrite) addPendingWikiWriteToMessage(convId, pendingWikiWrite)
        autoOpenSingleGeneratedOutput(convId, backendReferences)
        setAgentEvents([])
        abortRef.current = null
        activeRunSessionIdRef.current = null
        activeRunIdRef.current = null
        // save-worthy detection removed — user has direct "Save to Wiki" button on each message
      } catch (err) {
        if (!finalized) {
          if (isAbortLikeError(err) || runIdRef.current !== runId) {
            setStreaming(false)
            setAgentEvents([])
              abortRef.current = null
            activeRunSessionIdRef.current = null
            activeRunIdRef.current = null
            return
          }
          const message = err instanceof Error ? err.message : String(err)
          finalizeStreamForConversation(convId, `Error: ${message}`, undefined)
          setAgentEvents([])
        }
        abortRef.current = null
        activeRunSessionIdRef.current = null
        activeRunIdRef.current = null
      }
    },
    [project, llmConfig, searchApiConfig, addMessageToConversation, setStreaming, appendStreamToken, finalizeStreamForConversation, createConversation, maxHistoryMessages, t, availableSkills, autoOpenSingleGeneratedOutput, wikiWriteMode],
  )

  const handleStop = useCallback(() => {
    runIdRef.current += 1
    const sessionId = activeRunSessionIdRef.current
    const backendRunId = activeRunIdRef.current
    if (sessionId) {
      void invoke("agent_cancel_turn", {
        projectId: project?.id ?? "current",
        sessionId,
        runId: backendRunId ?? undefined,
      }).catch(() => {})
    }
    abortRef.current?.abort()
    abortRef.current = null
    activeRunSessionIdRef.current = null
    activeRunIdRef.current = null
    setStreaming(false)
    setAgentEvents([])
  }, [project, setStreaming])

  const handleNewConversation = useCallback(() => {
    handleStop()
    setReferencePreview(null)
    setGeneratedOutputPreviews([])
    setGeneratedOutputPreview(null)
    setApprovingShellMessageId(null)
    dismissedGeneratedOutputsKeyRef.current = null
    createConversation()
  }, [createConversation, handleStop])

  const handleSelectConversation = useCallback((conversationId: string) => {
    useChatStore.getState().setActiveConversation(conversationId)
    setApprovingShellMessageId(null)
  }, [])

  const handleRegenerate = useCallback(async () => {
    if (activeStreaming) return
    // Find the last user message in active conversation
    const active = useChatStore.getState().getActiveMessages()
    const lastUserMsg = [...active].reverse().find((m) => m.role === "user")
    if (!lastUserMsg) return
    // Remove the last assistant reply, then re-send
    removeLastAssistantMessage()
    // Small delay to let state update
    await new Promise((r) => setTimeout(r, 50))
    // Trigger send with the same text (handleSend will add a new user message,
    // so also remove the original to avoid duplication)
    // Actually: just call handleSend — but it adds a user message. To avoid dupe,
    // we remove the last user message too and let handleSend re-add it.
    const store = useChatStore.getState()
    const updatedActive = store.getActiveMessages()
    const lastUser = [...updatedActive].reverse().find((m) => m.role === "user")
    if (lastUser) {
      const activeId = useChatStore.getState().activeConversationId
      useChatStore.setState((s) => ({
        messages: s.messages.filter((m) => m.conversationId !== activeId || m.id !== lastUser.id),
      }))
    }
    // Re-send with the original text AND images so a regenerated turn
    // keeps the same vision context.
    handleSend(lastUserMsg.content, lastUserMsg.images ?? [])
  }, [activeStreaming, removeLastAssistantMessage, handleSend])

  const handleApproveShellCommand = useCallback(async (command: string, assistantMessageId: string) => {
    if (!command.trim() || approvingShellMessageId) return
    const active = useChatStore.getState().getActiveMessages()
    const assistantIndex = active.findIndex((message) => message.id === assistantMessageId)
    if (assistantIndex <= 0) {
      console.warn("[chat] shell approval ignored: assistant message not found", assistantMessageId)
      return
    }
    const priorUser = [...active.slice(0, assistantIndex)]
      .reverse()
      .find((message) => message.role === "user")
    if (!priorUser) {
      console.warn("[chat] shell approval ignored: no prior user message")
      return
    }
    const assistantMessage = active[assistantIndex]
    const resumeHistory = [
      ...compactChatHistoryForResume(active.slice(0, assistantIndex), maxHistoryMessages),
      {
        role: "assistant" as const,
        content: [
          "The previous Agent turn stopped at a shell approval boundary.",
          "Preserved tool progress before approval:",
          summarizeAgentStepsForResume(assistantMessage.agentSteps),
          "",
          assistantMessage.content,
        ].join("\n"),
      },
    ]
    const resumeMessage = [
      "Continue the same Agent task from the preserved tool progress. The user approved the pending shell command. Execute only that exact approved command first, then continue from its result. Do not restart completed setup, file reads, or workspace writes unless the command result proves they are invalid.",
    ].join("\n")
    setApprovingShellMessageId(assistantMessageId)
    // Approval is a continuation of a turn that has already stopped at a
    // permission boundary. Clear any stale streaming state before resuming so a
    // delayed store update cannot make the button feel inert.
    abortRef.current?.abort()
    abortRef.current = null
    activeRunSessionIdRef.current = null
    activeRunIdRef.current = null
    setStreaming(false)
    try {
      await handleSend(resumeMessage, priorUser.images ?? [], {
        useWebSearch: useChatStore.getState().useWebSearch,
        useAnyTxtSearch: useChatStore.getState().useAnyTxtSearch,
        agentMode: useChatStore.getState().agentMode,
        retrievalMode: useChatStore.getState().retrievalMode,
        skills: useChatStore.getState().selectedSkills,
        contextFiles: useChatStore.getState().selectedContextFiles,
        skillMode: useChatStore.getState().selectedSkills.length > 0 ? "explicit" : "auto",
        approvedShellCommands: [command.trim()],
        shellCommand: command.trim(),
        allowUnlimitedIterations: useWikiStore.getState().generalConfig.unlimitedAgentIterations,
        suppressUserMessage: true,
        historyOverride: resumeHistory,
      })
    } finally {
      setApprovingShellMessageId(null)
    }
  }, [approvingShellMessageId, handleSend, setStreaming])

  const recordShellCommandApproval = useCallback((messageId: string, command: string, decision: "approved" | "rejected" | "other", instructions?: string) => {
    const normalizedCommand = command.trim()
    let recorded = false
    useChatStore.setState((state) => ({
      messages: state.messages.map((message) => {
        if (message.id !== messageId || message.conversationId !== activeConversationId || message.role !== "assistant") return message
        const pendingCommand = message.agentSteps?.find((step) =>
          step.tool === "shell_exec"
          && step.status === "skipped"
          && step.message?.trim().startsWith("approval required:")
        )?.message?.trim().slice("approval required:".length).trim()
        if (pendingCommand !== normalizedCommand || message.shellCommandApproval) return message
        recorded = true
        return {
          ...message,
          shellCommandApproval: {
            command: normalizedCommand,
            decision,
            decidedAt: Date.now(),
            ...(instructions ? { instructions } : {}),
          },
        }
      }),
    }))
    return recorded
  }, [activeConversationId])

  const handleResolveShellCommand = useCallback(async (command: string, decision: "approved" | "rejected" | "other", instructions: string | undefined, assistantMessageId: string) => {
    if (!command.trim() || approvingShellMessageId || (decision === "other" && !instructions?.trim())) return
    if (!recordShellCommandApproval(assistantMessageId, command, decision, instructions)) return
    if (decision === "rejected") return
    if (decision === "approved") {
      await handleApproveShellCommand(command, assistantMessageId)
      return
    }

    const active = useChatStore.getState().getActiveMessages()
    const assistantIndex = active.findIndex((message) => message.id === assistantMessageId)
    const priorUser = assistantIndex > 0
      ? [...active.slice(0, assistantIndex)].reverse().find((message) => message.role === "user")
      : undefined
    const assistantMessage = assistantIndex > 0 ? active[assistantIndex] : undefined
    if (!priorUser || !assistantMessage || !instructions?.trim()) return
    const resumeHistory = [
      ...compactChatHistoryForResume(active.slice(0, assistantIndex), maxHistoryMessages),
      {
        role: "assistant" as const,
        content: [
          "The previous Agent turn stopped at a shell approval boundary.",
          "The user did not approve the pending shell command.",
          "Preserved tool progress before the decision:",
          summarizeAgentStepsForResume(assistantMessage.agentSteps),
          "",
          assistantMessage.content,
        ].join("\n"),
      },
    ]
    setApprovingShellMessageId(assistantMessageId)
    abortRef.current?.abort()
    abortRef.current = null
    activeRunSessionIdRef.current = null
    activeRunIdRef.current = null
    setStreaming(false)
    try {
      await handleSend([
        "Continue the same Agent task without executing the previously rejected shell command.",
        `User instructions: ${instructions.trim()}`,
        "Use a different approach. If shell access is still necessary, request approval for a new exact command.",
      ].join("\n"), priorUser.images ?? [], {
        useWebSearch: useChatStore.getState().useWebSearch,
        useAnyTxtSearch: useChatStore.getState().useAnyTxtSearch,
        agentMode: useChatStore.getState().agentMode,
        retrievalMode: useChatStore.getState().retrievalMode,
        skills: useChatStore.getState().selectedSkills,
        contextFiles: useChatStore.getState().selectedContextFiles,
        skillMode: useChatStore.getState().selectedSkills.length > 0 ? "explicit" : "auto",
        allowUnlimitedIterations: useWikiStore.getState().generalConfig.unlimitedAgentIterations,
        suppressUserMessage: true,
        historyOverride: resumeHistory,
      })
    } finally {
      setApprovingShellMessageId(null)
    }
  }, [approvingShellMessageId, handleApproveShellCommand, handleSend, maxHistoryMessages, recordShellCommandApproval, setStreaming])

  const handleSubmitUserInput = useCallback((request: ChatUserInputRequest, answers: Record<string, unknown>) => {
    if (activeStreaming) return false
    const answerLines = request.fields.map((field) => {
      const value = answers[field.id]
      const rendered = Array.isArray(value) ? value.join(", ") : String(value ?? "")
      return `- ${field.label} (${field.id}): ${rendered || "(empty)"}`
    })
    const resumeMessage = [
      `User provided answers for "${request.title}".`,
      "",
      ...answerLines,
      "",
      "Continue the previous task using these answers. Do not ask the same questions again unless required information is still missing.",
    ].join("\n")
    handleSend(resumeMessage, [], {
      useWebSearch: useChatStore.getState().useWebSearch,
      useAnyTxtSearch: useChatStore.getState().useAnyTxtSearch,
      agentMode: useChatStore.getState().agentMode,
      retrievalMode: useChatStore.getState().retrievalMode,
      skills: useChatStore.getState().selectedSkills,
      contextFiles: useChatStore.getState().selectedContextFiles,
      skillMode: useChatStore.getState().selectedSkills.length > 0 ? "explicit" : "auto",
      allowUnlimitedIterations: useWikiStore.getState().generalConfig.unlimitedAgentIterations,
    })
    return true
  }, [handleSend, activeStreaming])

  const addPendingWikiWriteToMessage = useCallback((conversationId: string, pendingWrite: ChatPendingWikiWrite) => {
    useChatStore.setState((state) => {
      const messages = [...state.messages]
      const index = [...messages].reverse().findIndex((message) => message.conversationId === conversationId && message.role === "assistant")
      if (index === -1) return state
      const messageIndex = messages.length - 1 - index
      messages[messageIndex] = { ...messages[messageIndex], pendingWikiWrite: pendingWrite }
      return { messages }
    })
  }, [])

  const addPendingMemoryProposalToMessage = useCallback((conversationId: string, memoryProposal: ChatMemoryProposal) => {
    useChatStore.setState((state) => {
      const messages = [...state.messages]
      const index = [...messages].reverse().findIndex((message) => message.conversationId === conversationId && message.role === "assistant")
      if (index === -1) return state
      const messageIndex = messages.length - 1 - index
      messages[messageIndex] = { ...messages[messageIndex], pendingMemoryProposal: memoryProposal }
      return { messages }
    })
  }, [])

  const handleAcceptMemoryProposal = useCallback(async (messageId: string, proposal: ChatMemoryProposal) => {
    if (!project || activeStreaming) return
    try {
      await invoke("memory_accept_proposal", {
        projectId: project.id,
        memoryId: proposal.memory.id,
      })
    } catch (error) {
      console.error("[chat] failed to accept memory proposal:", error)
    }
    useChatStore.setState((state) => ({
      messages: state.messages.map((message) => message.id === messageId
        ? { ...message, pendingMemoryProposal: undefined }
        : message),
    }))
  }, [activeStreaming, project])

  const handleRejectMemoryProposal = useCallback(async (messageId: string, proposal: ChatMemoryProposal) => {
    if (!project || activeStreaming) return
    try {
      await invoke("memory_reject_proposal", {
        projectId: project.id,
        memoryId: proposal.memory.id,
        reason: "rejected in chat",
      })
    } catch (error) {
      console.error("[chat] failed to reject memory proposal:", error)
    }
    useChatStore.setState((state) => ({
      messages: state.messages.map((message) => message.id === messageId
        ? { ...message, pendingMemoryProposal: undefined }
        : message),
    }))
  }, [activeStreaming, project])

  const addPendingSchemaProposalToMessage = useCallback((conversationId: string, proposal: ChatSchemaProposal) => {
    useChatStore.setState((state) => {
      const messages = [...state.messages]
      const index = [...messages].reverse().findIndex((message) => message.conversationId === conversationId && message.role === "assistant")
      if (index === -1) return state
      const messageIndex = messages.length - 1 - index
      messages[messageIndex] = { ...messages[messageIndex], pendingSchemaProposal: proposal }
      return { messages }
    })
  }, [])

  const handleApplySchemaProposal = useCallback(async (messageId: string, proposal: ChatSchemaProposal) => {
    if (!project || activeStreaming) return
    try {
      await invoke("schema_apply_proposal", {
        projectId: project.id,
        sessionId: activeConversationId,
        proposalId: proposal.id,
        expectedSchemaHash: proposal.baseSchemaHash,
      })
      useChatStore.setState((state) => ({
        messages: state.messages.map((message) => message.id === messageId
          ? { ...message, pendingSchemaProposal: { ...proposal, status: "applied" } }
          : message),
      }))
      await refreshProjectFileTree(project.path, { bumpDataVersion: true })
    } catch (error) {
      console.error("[chat] failed to apply schema proposal:", error)
    }
  }, [activeConversationId, activeStreaming, project])

  const handleRejectSchemaProposal = useCallback(async (messageId: string, proposal: ChatSchemaProposal) => {
    if (!project || activeStreaming) return
    try {
      await invoke("schema_reject_proposal", {
        projectId: project.id,
        sessionId: activeConversationId,
        proposalId: proposal.id,
      })
      useChatStore.setState((state) => ({
        messages: state.messages.map((message) => message.id === messageId
          ? { ...message, pendingSchemaProposal: { ...proposal, status: "rejected" } }
          : message),
      }))
    } catch (error) {
      console.error("[chat] failed to reject schema proposal:", error)
    }
  }, [activeConversationId, activeStreaming, project])

  const handleConfirmPendingWikiWrite = useCallback(async (messageId: string, pendingWrite: ChatPendingWikiWrite) => {
    if (!project) return
    if (activeStreaming) {
      console.warn("[chat] wiki confirm ignored: another turn is still streaming")
      return
    }
    const active = useChatStore.getState().getActiveMessages()
    const assistantIndex = active.findIndex((message) => message.id === messageId)
    const priorUser = assistantIndex > 0
      ? [...active.slice(0, assistantIndex)]
          .reverse()
          .find((message) => message.role === "user")
      : undefined
    const assistantMessage = assistantIndex > 0 ? active[assistantIndex] : undefined
    let resumeHistory: { role: "user" | "assistant"; content: string }[] | undefined
    if (assistantMessage && priorUser) {
      resumeHistory = [
        ...compactChatHistoryForResume(active.slice(0, assistantIndex), maxHistoryMessages),
        {
          role: "assistant" as const,
          content: [
            "The previous Agent turn stopped at a wiki.write_page confirmation boundary.",
            "Preserved tool progress before confirmation:",
            summarizeAgentStepsForResume(assistantMessage.agentSteps),
            "",
            assistantMessage.content,
          ].join("\n"),
        },
      ]
    }
    const confirmed = await confirmPendingWikiWrite({
      pendingWrite,
      projectId: project.id,
      projectPath: project.path,
      sessionId: activeConversationId,
      confirm: (projectId, sessionId, pendingWriteId) => invoke("agent_confirm_wiki_write", { projectId, sessionId, pendingWriteId }),
    })
    const change = summarizeConfirmedWikiWrite({
      ...confirmed,
      id: pendingWrite.id,
      timestamp: Date.now(),
      diffUnavailable: t("chat.agentChanges.diffUnavailable"),
    })
    useChatStore.setState((state) => ({
      messages: state.messages.map((message) => message.id === messageId
        ? { ...message, pendingWikiWrite: undefined, agentFileChanges: [...(message.agentFileChanges ?? []), change] }
        : message),
    }))
    onConfirmedWrite?.()
    void refreshConfirmedWikiWrite({
      projectPath: project.path,
      confirmedPath: confirmed.path,
      refresh: refreshProjectFileTree,
      getSelectedFile: () => useWikiStore.getState().selectedFile,
      read: readFile,
      setFileContent: useWikiStore.getState().setFileContent,
    })
    // Resume the agent loop so any remaining tool calls or the final answer fire
    // automatically — without this, the run stops at the confirmation boundary
    // and the user has to manually type "continue" to unblock it (Bug 1).
    const resumeMessage = [
      `Confirmed. wiki.write_page to ${pendingWrite.path} was approved by the user and the file is now saved on disk.`,
      "",
      "Continue the same Agent task from the preserved tool progress. The original request may still have more pages, references to read, or a final answer to compose. Do not restart completed searches or file reads unless the user explicitly asked for them. When the original task is complete (or no further work is justified), return final with a brief confirmation of which pages were written.",
    ].join("\n")
    // Mirror the shell-approval flow: suppress the user-visible bubble, but
    // pass the preserved history so the agent has full context, and clear any
    // stale streaming state left over from the paused turn.
    abortRef.current?.abort()
    abortRef.current = null
    activeRunSessionIdRef.current = null
    activeRunIdRef.current = null
    setStreaming(false)
    try {
      await handleSend(resumeMessage, priorUser?.images ?? [], {
        useWebSearch: useChatStore.getState().useWebSearch,
        useAnyTxtSearch: useChatStore.getState().useAnyTxtSearch,
        agentMode: useChatStore.getState().agentMode,
        retrievalMode: useChatStore.getState().retrievalMode,
        skills: useChatStore.getState().selectedSkills,
        contextFiles: useChatStore.getState().selectedContextFiles,
        skillMode: useChatStore.getState().selectedSkills.length > 0 ? "explicit" : "auto",
        allowUnlimitedIterations: useWikiStore.getState().generalConfig.unlimitedAgentIterations,
        suppressUserMessage: true,
        ...(resumeHistory ? { historyOverride: resumeHistory } : {}),
      })
    } catch (err) {
      console.error("[chat] failed to resume after wiki write confirmation:", err)
    }
  }, [activeConversationId, activeStreaming, handleSend, maxHistoryMessages, onConfirmedWrite, project, setStreaming, t])

  const handleCancelPendingWikiWrite = useCallback((messageId: string) => {
    useChatStore.setState((state) => ({ messages: cancelPendingWikiWrite(state.messages, messageId) }))
  }, [])

  const handleWriteToWiki = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      await executeIngestWrites(pp, llmConfig, undefined, undefined)
      await refreshProjectFileTree(pp, { bumpDataVersion: true })
    } catch (err) {
      console.error("Failed to write to wiki:", err)
    }
  }, [project, llmConfig])

  const hasAssistantMessages = activeMessages.some((m) => m.role === "assistant")
  const showWriteButton = mode === "ingest" && !activeStreaming && hasAssistantMessages

  return (
    <div className="flex h-full flex-row overflow-hidden">
      {showConversationControls && <ConversationSidebar
        onNewConversation={handleNewConversation}
        onSelectConversation={handleSelectConversation}
      />}

      <div className="flex flex-1 flex-col overflow-hidden">
        {!activeConversationId ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageSquare className="mx-auto mb-3 h-8 w-8 opacity-30" />
              <p className="text-sm">{t("chat.startNewConversation")}</p>
              <p className="mt-1 text-xs opacity-60">{t("chat.clickNewChatToBegin")}</p>
            </div>
          </div>
          ) : (
            <>
              {enhancedShellMode && enhancedShellBannerShownForConv && !enhancedShellBannerDismissed && (
                <div
                  data-testid="enhanced-shell-banner"
                  className="flex items-start gap-2 border-b border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs"
                  role="status"
                >
                  <span className="mt-0.5 inline-block h-2 w-2 flex-shrink-0 rounded-full bg-sky-500" aria-hidden />
                  <div className="min-w-0 flex-1 leading-snug">
                    <div className="font-medium">
                      {t("chat.enhancedShell.bannerTitle", {
                        defaultValue: "Enhanced shell mode active",
                      })}
                    </div>
                    <div className="text-muted-foreground">
                      {t("chat.enhancedShell.bannerBody", {
                        defaultValue:
                          "Common dev tools (python, pip, uv, git, rg, grep, cat, node, npm, cargo, …) run without per-call prompts. Network clients, sudo, destructive system paths and shell substitution still require approval. Manage in Settings → General.",
                      })}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEnhancedShellBannerDismissed(true)}
                    className="flex-shrink-0 rounded px-2 py-1 text-muted-foreground hover:bg-sky-500/10 hover:text-foreground"
                    aria-label={t("chat.enhancedShell.bannerDismiss", {
                      defaultValue: "Dismiss",
                    })}
                  >
                    {t("chat.enhancedShell.bannerDismiss", { defaultValue: "Dismiss" })}
                  </button>
                </div>
              )}
              <div
                ref={scrollContainerRef}
                className="flex-1 overflow-y-auto px-3 py-2"
              >
                <div className="flex flex-col gap-3">
                  {activeMessages.map((msg, idx) => {
                    // Check if this is the last assistant message
                    const isLastAssistant = msg.role === "assistant" &&
                      !activeMessages.slice(idx + 1).some((m) => m.role === "assistant")
                    return (
                      <>
                      <ChatMessage
                        key={`${msg.conversationId}:${msg.id}:${msg.timestamp}:${idx}`}
                        message={msg}
                        isLastAssistant={isLastAssistant && !activeStreaming}
                        onRegenerate={isLastAssistant ? handleRegenerate : undefined}
                        onOpenReferencePreview={handleOpenReferencePreview}
                        onResolveShellCommand={
                          isLastAssistant && approvingShellMessageId !== msg.id
                            ? (command, decision, instructions) => void handleResolveShellCommand(command, decision, instructions, msg.id)
                            : undefined
                        }
                        onSubmitUserInput={isLastAssistant ? handleSubmitUserInput : undefined}
                      />
                      {msg.pendingWikiWrite && <WikiWriteConfirmationCard pendingWrite={msg.pendingWikiWrite} onConfirm={() => void handleConfirmPendingWikiWrite(msg.id, msg.pendingWikiWrite!)} onCancel={() => handleCancelPendingWikiWrite(msg.id)} />}
                      {msg.pendingSchemaProposal && (
                        <SchemaProposalCard
                          proposal={msg.pendingSchemaProposal}
                          disabled={activeStreaming || !isLastAssistant}
                          onApply={() => void handleApplySchemaProposal(msg.id, msg.pendingSchemaProposal!)}
                          onReject={() => void handleRejectSchemaProposal(msg.id, msg.pendingSchemaProposal!)}
                        />
                      )}
                      {msg.pendingMemoryProposal && (
                        <MemoryProposalCard
                          proposal={msg.pendingMemoryProposal}
                          disabled={activeStreaming || !isLastAssistant}
                          onAccept={() => void handleAcceptMemoryProposal(msg.id, msg.pendingMemoryProposal!)}
                          onReject={() => void handleRejectMemoryProposal(msg.id, msg.pendingMemoryProposal!)}
                        />
                      )}
                      </>
                    )
                  })}
                  {activeStreaming && <StreamingMessage content={streamingContent} agentEvents={activeAgentEvents} />}
                  <div ref={bottomRef} />
                </div>
              </div>

            {showWriteButton && (
              <div className="border-t px-3 py-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleWriteToWiki}
                  className="w-full gap-2"
                >
                  <BookOpen className="h-4 w-4" />
                  {t("chat.writeToWiki")}
                </Button>
              </div>
            )}
          </>
        )}

        <ChatInput
          onSend={handleSend}
          onStop={handleStop}
          isStreaming={activeStreaming}
          useWebSearch={useWebSearch}
          useAnyTxtSearch={useAnyTxtSearch}
          agentMode={agentMode}
          retrievalMode={retrievalMode}
          availableSkills={availableSkills}
          selectedSkills={selectedSkills}
          availableContextFiles={availableContextFiles}
          selectedContextFiles={selectedContextFiles}
          onUseWebSearchChange={setUseWebSearch}
          onUseAnyTxtSearchChange={setUseAnyTxtSearch}
          onAgentModeChange={setAgentMode}
          onRetrievalModeChange={setRetrievalMode}
          onSelectedSkillsChange={setSelectedSkills}
          onSelectedContextFilesChange={setSelectedContextFiles}
          anyTxtAvailable={anyTxtAvailable}
          imageInputAvailable={imageInputAvailable}
          placeholder={
            mode === "ingest"
              ? t("chat.ingestPlaceholder")
              : t("chat.typeAMessage")
          }
        />
      </div>

      {referencePreview && (
        <ChatReferencePreviewPanel
          preview={referencePreview}
          width={referencePreviewWidth}
          onResize={setReferencePreviewWidth}
          onClose={() => setReferencePreview(null)}
        />
      )}
      {generatedOutputPreviews.length > 0 && (
        <GeneratedOutputsPanel
          outputs={generatedOutputPreviews}
          onOpen={openGeneratedOutputModal}
          onOpenDirectory={project ? openGeneratedOutputDirectory : undefined}
          onClose={closeGeneratedOutputsPanel}
        />
      )}
      {generatedOutputPreview && (
        <GeneratedOutputPreviewDialog
          preview={generatedOutputPreview}
          onClose={() => setGeneratedOutputPreview(null)}
        />
      )}
    </div>
  )
}

function GeneratedOutputsPanel({
  outputs,
  onOpen,
  onOpenDirectory,
  onClose,
}: {
  outputs: ChatReferencePreview[]
  onOpen: (preview: ChatReferencePreview) => void
  onOpenDirectory?: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-l bg-background">
      <div className="flex min-h-10 items-center gap-2 border-b px-3 py-2">
        <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{t("chat.generatedOutputs")}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {t("chat.generatedOutputCount", { count: outputs.length })}
          </div>
        </div>
        {onOpenDirectory && (
          <button
            type="button"
            onClick={onOpenDirectory}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("chat.openGeneratedOutputFolder", { defaultValue: "Open output folder" })}
            aria-label={t("chat.openGeneratedOutputFolder", { defaultValue: "Open output folder" })}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("chat.closeGeneratedOutputs")}
          aria-label={t("chat.closeGeneratedOutputs")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="space-y-1">
          {outputs.map((output) => {
            const title = output.title || getFileName(output.path)
            const isImageOutput = isGeneratedOutputImage(output.path)
            const imageSrc = isImageOutput ? convertFileSrc(output.path) : null
            return (
              <button
                key={output.path}
                type="button"
                onClick={() => onOpen(output)}
                className="group flex w-full items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-2 text-left transition-colors hover:border-primary/30 hover:bg-primary/5"
                title={output.path}
              >
                {imageSrc ? (
                  <span className="h-10 w-12 shrink-0 overflow-hidden rounded border border-primary/20 bg-background/80">
                    <img
                      src={imageSrc}
                      alt={title}
                      loading="lazy"
                      className="h-full w-full object-cover"
                      onError={(event) => {
                        event.currentTarget.style.opacity = "0"
                      }}
                    />
                  </span>
                ) : (
                  <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">{title}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{output.path}</span>
                </span>
                <Maximize2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

function GeneratedOutputPreviewDialog({
  preview,
  onClose,
}: {
  preview: ChatReferencePreview
  onClose: () => void
}) {
  const { t } = useTranslation()
  const displayTitle = preview.title || getFileName(preview.path)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6">
      <div className="flex h-[86vh] w-[80vw] min-w-0 max-w-[1600px] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl">
        <div className="flex min-h-12 items-center gap-3 border-b px-4 py-2">
          <Maximize2 className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" title={displayTitle}>{displayTitle}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={preview.path}>{preview.path}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("chat.closeGeneratedOutputPreview")}
            aria-label={t("chat.closeGeneratedOutputPreview")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChatReferencePreviewContent preview={preview} />
        </div>
      </div>
    </div>
  )
}

function ChatReferencePreviewPanel({
  preview,
  width,
  onResize,
  onClose,
}: {
  preview: ChatReferencePreview
  width: number
  onResize: (width: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const displayTitle = preview.title || getFileName(preview.path)
  const dragStartRef = useRef<{ x: number; width: number } | null>(null)

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragStartRef.current = { x: event.clientX, width }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [width])

  const handleResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return
    const delta = dragStartRef.current.x - event.clientX
    onResize(clampReferencePreviewWidth(dragStartRef.current.width + delta))
  }, [onResize])

  const stopResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragStartRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  return (
    <aside
      className="relative flex h-full min-w-[320px] max-w-[56%] shrink-0 flex-col border-l bg-background"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("chat.resizeReferencePreview")}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={handleResize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            onResize(clampReferencePreviewWidth(width + 32))
          } else if (event.key === "ArrowRight") {
            event.preventDefault()
            onResize(clampReferencePreviewWidth(width - 32))
          }
        }}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize outline-none transition-colors hover:bg-primary/15 focus-visible:bg-primary/20"
      />
      <div className="flex min-h-10 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium" title={displayTitle}>
            {displayTitle}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={preview.path}>
            {preview.source ?? t("chat.referencePreview")} · {preview.path}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("chat.closeReferencePreview")}
          aria-label={t("chat.closeReferencePreview")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <ChatReferencePreviewContent preview={preview} />
      </div>
    </aside>
  )
}

function MemoryProposalCard({
  proposal,
  disabled,
  onAccept,
  onReject,
}: {
  proposal: ChatMemoryProposal
  disabled: boolean
  onAccept: () => void
  onReject: () => void
}) {
  const { t } = useTranslation()
  const memory = proposal.memory
  const scopeLabel = memory.scope === "project" ? t("chat.memoryProposal.scopeProject") : t("chat.memoryProposal.scopeSession")
  const confidenceLabel = (() => {
    switch (memory.confidence) {
      case "user_confirmed": return t("chat.memoryProposal.confidenceUser")
      case "evidence_backed": return t("chat.memoryProposal.confidenceEvidence")
      default: return t("chat.memoryProposal.confidenceAgent")
    }
  })()
  return (
    <section className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-sm" aria-label={t("chat.memoryProposal.title")}>
      <div className="font-medium">{t("chat.memoryProposal.pending")}</div>
      <p className="mt-1 text-xs text-muted-foreground">{t("chat.memoryProposal.description")}</p>
      <div className="mt-2 grid gap-1 text-xs">
        <span><strong>{t("chat.memoryProposal.kind")}</strong>: {memory.kind}</span>
        <span><strong>{t("chat.memoryProposal.scope")}</strong>: {scopeLabel}</span>
        <span><strong>{t("chat.memoryProposal.confidence")}</strong>: {confidenceLabel}</span>
        <span><strong>{t("chat.memoryProposal.titleLabel")}</strong>: {memory.title}</span>
      </div>
      <pre className="mt-2 max-h-44 overflow-auto rounded border border-border/60 bg-muted/40 p-2 whitespace-pre-wrap break-words font-sans text-xs">{memory.content}</pre>
      <p className="mt-2 text-[11px] text-muted-foreground">{t("chat.memoryProposal.reasonLabel")}: {memory.reason}</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={disabled} onClick={onReject}>{t("chat.memoryProposal.reject")}</Button>
        <Button size="sm" disabled={disabled} onClick={onAccept}>{t("chat.memoryProposal.accept")}</Button>
      </div>
    </section>
  )
}

function SchemaProposalCard({
  proposal,
  disabled,
  onApply,
  onReject,
}: {
  proposal: ChatSchemaProposal
  disabled: boolean
  onApply: () => void
  onReject: () => void
}) {
  const { t } = useTranslation()
  const isPending = proposal.status === "pending"
  const status = proposal.status === "applied"
    ? t("chat.schemaProposal.applied")
    : proposal.status === "rejected"
      ? t("chat.schemaProposal.rejected")
      : t("chat.schemaProposal.pending")
  return (
    <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm" aria-label={t("chat.schemaProposal.title")}>
      <div className="font-medium">{status}</div>
      <p className="mt-1 text-xs text-muted-foreground">{t("chat.schemaProposal.description")}</p>
      <div className="mt-2 grid gap-1 text-xs">
        <span>{t("chat.schemaProposal.baseRevision")}: <code className="break-all">{proposal.baseSchemaHash}</code></span>
        <span>{t("chat.schemaProposal.affectedPages", { count: proposal.impact.affectedPages.length })}</span>
        {proposal.requiredDirectories.length > 0 && <span>{t("chat.schemaProposal.directories")}: {proposal.requiredDirectories.join(", ")}</span>}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-primary">{t("chat.schemaProposal.viewSchema")}</summary>
        <pre className="mt-2 max-h-56 overflow-auto rounded border border-border/60 bg-muted/40 p-2 whitespace-pre-wrap break-all font-mono text-[11px] text-foreground"><code>{proposal.proposedSchema}</code></pre>
      </details>
      {proposal.impact.affectedPages.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">{t("chat.schemaProposal.affectedPages", { count: proposal.impact.affectedPages.length })}</summary>
          <ul className="mt-1 max-h-28 overflow-auto space-y-1 text-[11px] text-muted-foreground">
            {proposal.impact.affectedPages.map((page) => <li key={`${page.path}:${page.code}`}><code>{page.path}</code> — {page.message}</li>)}
          </ul>
        </details>
      )}
      {isPending && (
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={disabled} onClick={onReject}>{t("chat.schemaProposal.reject")}</Button>
          <Button size="sm" disabled={disabled} onClick={onApply}>{t("chat.schemaProposal.apply")}</Button>
        </div>
      )}
    </section>
  )
}

function ChatReferencePreviewContent({ preview }: { preview: ChatReferencePreview }) {
  if (preview.external) return <ExternalReferencePreview preview={preview} />
  if (getFileCategory(preview.path) === "markdown") {
    return <ChatMarkdownReferencePreview preview={preview} />
  }
  return (
    <FilePreview
      key={preview.path}
      filePath={preview.path}
      textContent={preview.content}
    />
  )
}

function clampReferencePreviewWidth(width: number): number {
  return Math.min(760, Math.max(320, Math.round(width)))
}

function ChatMarkdownReferencePreview({ preview }: { preview: ChatReferencePreview }) {
  const { frontmatter, body } = parseFrontmatter(preview.content)
  return (
    <div className="h-full overflow-auto px-6 py-6">
      {frontmatter && <FrontmatterPanel data={frontmatter} />}
      <WikiReader body={body} filePath={preview.path} />
    </div>
  )
}

function ExternalReferencePreview({ preview }: { preview: ChatReferencePreview }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col overflow-auto p-5">
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-2">
          {preview.source && (
            <span className="rounded border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
              {preview.source}
            </span>
          )}
          <h3 className="truncate text-sm font-medium" title={preview.title}>{preview.title}</h3>
        </div>
        <div className="break-all rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {preview.path.replace(/^[a-z]+-preview:\/\//, "")}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60 bg-muted/20 p-4">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
          {preview.snippet?.trim() || t("chat.noReferencePreviewFragment")}
        </pre>
      </div>
    </div>
  )
}

function isAbortLikeError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true
  if (!(err instanceof Error)) return false
  return err.name === "AbortError" || /abort|cancel/i.test(err.message)
}

export function WikiWriteConfirmationCard({ pendingWrite, onConfirm, onCancel }: { pendingWrite: ChatPendingWikiWrite; onConfirm: (id: string) => void; onCancel: () => void }) {
  return <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
    <div className="font-medium">{pendingWrite.path}</div>
    {pendingWrite.existedBefore && <div className="mt-1 text-xs text-amber-800 dark:text-amber-200">Overwrites an existing page</div>}
    <pre className="mt-2 max-h-24 overflow-hidden whitespace-pre-wrap text-xs">{pendingWrite.content.slice(0, 500)}</pre>
    <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => onConfirm(pendingWrite.id)}>Confirm write</Button><Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button></div>
  </div>
}
