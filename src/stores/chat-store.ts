import { create } from "zustand"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { BackendAgentEventPayload } from "@/lib/chat-annotation-stream"
import type { ChatMessage, ContentBlock } from "@/lib/llm-client"
import i18n from "@/i18n"
import type { ChatAgentFileChange, ChatAgentMode, ChatAnnotation, ChatMemoryProposal, ChatPendingWikiWrite, ChatAgentStep, ChatRetrievalMode, ChatSchemaProposal, ChatShellCommandApproval, ChatUserInputRequest } from "@/lib/chat-agent-types"
import type { WikiWriteMode } from "@/lib/wiki-page-context"

/**
 * An image attached to a user message. Field names mirror the
 * `image` variant of `ContentBlock` (see llm-providers.ts) so
 * converting a DisplayMessage into a wire ContentBlock is a no-op
 * spread — no remapping, no `data:` framing here (the provider
 * translators own that).
 */
export interface MessageImage {
  mediaType: string
  dataBase64: string
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  selectedSkills?: string[]
  contextFiles?: string[]
  manualContextFiles?: string[]
  wikiWriteMode?: WikiWriteMode
}

export interface MessageReference {
  title: string
  path: string
  kind?: "wiki" | "external" | "workspace"
  source?: string
  url?: string
  snippet?: string
  graphRelations?: string[]
}

export interface DisplayMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: number
  conversationId: string
  references?: MessageReference[]  // pages cited in this response, saved at creation time
  agentSteps?: ChatAgentStep[]  // agent tool calls and routing decisions saved with assistant replies
  agentFileChanges?: ChatAgentFileChange[]  // concrete project files changed by this Agent turn
  userInputRequest?: ChatUserInputRequest  // dynamic schema-driven form requested by backend Agent
  images?: MessageImage[]  // images attached to a user message (vision input)
  contextFiles?: string[]  // absolute project files explicitly attached to this user turn
  pendingWikiWrite?: ChatPendingWikiWrite  // staged Wiki write requiring user confirmation
  pendingSchemaProposal?: ChatSchemaProposal  // staged Schema update requiring user confirmation
  pendingMemoryProposal?: ChatMemoryProposal  // staged Memory entry requiring user confirmation
  shellCommandApproval?: ChatShellCommandApproval  // resolved Shell authorization boundary for this Agent turn
  shellApprovalRequest?: import("@/lib/chat-agent-types").ChatShellApprovalRequest  // structured pending Shell approval
  /** 旁注：snippet 锚定的子对话数组 */
  annotations?: ChatAnnotation[]
  /** 仅 annotation.thread 内 message 有此标记；用于 chatMessagesToLLM 过滤 */
  threadKind?: "annotation"
  /** 仅 flatten 后写入主 conversation 的 message 有此标记 */
  flattenedFromAnnotation?: string
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingTargets: { main: boolean; annotations: Set<string> }
  streamingContent: string
  mode: "chat" | "ingest"
  ingestSource: string | null
  maxHistoryMessages: number
  useWebSearch: boolean
  useAnyTxtSearch: boolean
  agentMode: ChatAgentMode
  retrievalMode: ChatRetrievalMode
  selectedSkills: string[]
  selectedContextFiles: string[]
  disabledSkills: string[]
  /**
   * Right-pane annotation drawer target. Holds the id of the
   * assistant message whose annotations the user is currently
   * inspecting, or `null` when the drawer is closed.
   *
   * Lives in the store (rather than as local component state in
   * `ChatSessionContent`) so `AppLayout` can subscribe and enforce
   * the right-pane mutex required by the project CLAUDE.md: when
   * the drawer is open in chat-view, the outer Research pane must
   * close so the two right-pane surfaces never appear side-by-side.
   * ChatSessionContent also writes to this field on unmount so a
   * freshly mounted instance (e.g. switching from ChatPanel to
   * WikiPageAssistant) does not pick up a stale drawer.
   */
  annotationDrawerOpen: string | null

  // Conversation management
  createConversation: () => string
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string | null) => void
  renameConversation: (id: string, title: string) => void

  // Message management
  addMessage: (role: DisplayMessage["role"], content: string, images?: MessageImage[]) => void
  addMessageToConversation: (conversationId: string, role: DisplayMessage["role"], content: string, images?: MessageImage[], contextFiles?: string[]) => void
  setMessages: (messages: DisplayMessage[]) => void
  setConversations: (conversations: Conversation[]) => void
  setStreaming: (streaming: boolean) => void
  startMainStream: () => void
  endMainStream: () => void
  startAnnotationStream: (annotationId: string) => void
  endAnnotationStream: (annotationId: string) => void
  appendStreamToken: (token: string) => void
  finalizeStream: (content: string, references?: MessageReference[], agentSteps?: ChatAgentStep[], userInputRequest?: ChatUserInputRequest, agentFileChanges?: ChatAgentFileChange[]) => void
  finalizeStreamForConversation: (conversationId: string, content: string, references?: MessageReference[], agentSteps?: ChatAgentStep[], userInputRequest?: ChatUserInputRequest, agentFileChanges?: ChatAgentFileChange[]) => void
  setMode: (mode: ChatState["mode"]) => void
  setIngestSource: (path: string | null) => void
  clearMessages: () => void
  setMaxHistoryMessages: (n: number) => void
  setUseWebSearch: (enabled: boolean) => void
  setUseAnyTxtSearch: (enabled: boolean) => void
  setAgentMode: (mode: ChatAgentMode) => void
  setRetrievalMode: (mode: ChatRetrievalMode) => void
  setSelectedSkills: (skills: string[]) => void
  setSelectedContextFiles: (paths: string[]) => void
  setManualContextFiles: (paths: string[]) => void
  setWikiWriteMode: (mode: WikiWriteMode) => void
  setDisabledSkills: (skills: string[]) => void
  removeLastAssistantMessage: () => void  // for regenerate: remove last assistant reply

  // Annotation management
  createAnnotation: (parentMessageId: string, snippet: string, range?: { start: number; end: number }) => string
  appendAnnotationMessage: (annotationId: string, role: "user" | "assistant", content: string) => void
  appendAnnotationAgentStep: (annotationId: string, step: ChatAgentStep) => void
  resolveAnnotation: (annotationId: string) => void
  flattenAnnotation: (annotationId: string) => string[]
  setAnnotationDrawerOpen: (messageId: string | null) => void
  /**
   * Task 6.1 / 6.2: save annotation to wiki scaffolding.
   *
   * Records `wikiPath` on the matching annotation so the inline view
   * can surface a "📄 已保存" backlink chip (Task 6.2). The actual
   * file write is intentionally deferred: per project CLAUDE.md, all
   * wiki writes must route through the Agent's `wiki.write_page` tool
   * so existing pages get the controlled `pending_writes` confirmation
   * flow. Wiring that end-to-end is tracked as follow-up work; this
   * action provides the in-memory state hook so the dialog and chip
   * UX can ship now.
   */
  saveAnnotationToWiki: (annotationId: string, targetPath: string, content: string) => void
  /**
   * Combined annotation question dispatch (Phase 7.x): create an empty
   * annotation row, append the user's question to its thread, register a
   * run-scoped event listener, then invoke the backend Agent with annotation
   * context. Returns the new annotation id, or `null` if creation was rejected
   * (parent message gone, etc.).
   */
  askAnnotationQuestion: (args: {
    parentMessageId: string
    snippet: string
    range?: { start: number; end: number }
    question: string
  }) => Promise<string | null>

  // Helpers
  getActiveMessages: () => DisplayMessage[]
}


let messageCounter = 0

function nextId(): string {
  messageCounter += 1
  return `msg_${Date.now()}_${messageCounter}_${Math.random().toString(36).slice(2, 8)}`
}

function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  isStreaming: false,
  streamingTargets: { main: false, annotations: new Set() },
  streamingContent: "",
  mode: "chat",
  ingestSource: null,
  maxHistoryMessages: 10,
  useWebSearch: false,
  useAnyTxtSearch: false,
  agentMode: "standard",
  retrievalMode: "standard",
  selectedSkills: [],
  selectedContextFiles: [],
  disabledSkills: [],
  annotationDrawerOpen: null,

  createConversation: () => {
    const id = generateConversationId()
    const now = Date.now()
    const newConversation: Conversation = {
      id,
      title: i18n.t("chat.newConversation"),
      createdAt: now,
      updatedAt: now,
      selectedSkills: [],
      contextFiles: [],
      manualContextFiles: [],
      wikiWriteMode: "confirm",
    }
    set((state) => ({
      conversations: [newConversation, ...state.conversations],
      activeConversationId: id,
      isStreaming: false,
      streamingContent: "",
      selectedSkills: [],
      selectedContextFiles: [],
    }))
    return id
  },

  deleteConversation: (id) =>
    set((state) => {
      const remaining = state.conversations.filter((c) => c.id !== id)
      const newActiveId =
        state.activeConversationId === id
          ? (remaining[0]?.id ?? null)
          : state.activeConversationId
      return {
        conversations: remaining,
        messages: state.messages.filter((m) => m.conversationId !== id),
        activeConversationId: newActiveId,
        selectedSkills: remaining.find((conversation) => conversation.id === newActiveId)?.selectedSkills ?? [],
        selectedContextFiles: remaining.find((conversation) => conversation.id === newActiveId)?.contextFiles ?? [],
      }
    }),

  setActiveConversation: (id) =>
    set((state) => ({
      activeConversationId: id,
      streamingContent: "",
      selectedSkills: state.conversations.find((conversation) => conversation.id === id)?.selectedSkills ?? [],
      selectedContextFiles: state.conversations.find((conversation) => conversation.id === id)?.contextFiles ?? [],
    })),

  renameConversation: (id, title) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c
      ),
    })),

  addMessage: (role, content, images) => {
    const activeConversationId = get().activeConversationId
    if (!activeConversationId) return
    get().addMessageToConversation(activeConversationId, role, content, images)
  },

  addMessageToConversation: (conversationId, role, content, images, contextFiles) =>
    set((state) => {
      const { conversations } = state
      if (!conversations.some((conversation) => conversation.id === conversationId)) return state

      const newMessage: DisplayMessage = {
        id: nextId(),
        role,
        content,
        timestamp: Date.now(),
        conversationId,
        ...(images && images.length > 0 ? { images } : {}),
        ...(contextFiles && contextFiles.length > 0 ? { contextFiles } : {}),
      }

      // Auto-set title from first user message (first 50 chars)
      const convMessages = state.messages.filter(
        (m) => m.conversationId === conversationId && m.role === "user"
      )
      const updatedConversations =
        role === "user" && convMessages.length === 0
          ? conversations.map((c) =>
              c.id === conversationId
                ? {
                    ...c,
                    // Image-only first message has empty text; fall
                    // back to a generic title so the sidebar entry
                    // isn't blank.
                    title: content.slice(0, 50) || (images && images.length > 0 ? i18n.t("chat.imageMessage") : c.title),
                    updatedAt: Date.now(),
                  }
                : c
            )
          : conversations.map((c) =>
              c.id === conversationId
                ? { ...c, updatedAt: Date.now() }
                : c
            )

      return {
        messages: [...state.messages, newMessage],
        conversations: updatedConversations,
      }
    }),

  setMessages: (messages) => set({ messages }),

  setConversations: (conversations) =>
    set((state) => ({
      conversations,
      selectedSkills: conversations.find((conversation) => conversation.id === state.activeConversationId)?.selectedSkills ?? [],
      selectedContextFiles: conversations.find((conversation) => conversation.id === state.activeConversationId)?.contextFiles ?? [],
    })),

  setStreaming: (isStreaming) => set((state) => ({
    isStreaming,
    // Each new run owns its own stream buffer. Without this reset, a newly
    // created conversation can briefly render tokens left by another
    // conversation until the next token arrives.
    ...(isStreaming ? { streamingContent: "" } : state.streamingContent ? {} : {}),
  })),

  startMainStream: () =>
    set((state) => ({
      streamingTargets: { ...state.streamingTargets, main: true },
    })),

  endMainStream: () =>
    set((state) => ({
      streamingTargets: { ...state.streamingTargets, main: false },
    })),

  startAnnotationStream: (annotationId) =>
    set((state) => ({
      streamingTargets: {
        ...state.streamingTargets,
        annotations: new Set([...state.streamingTargets.annotations, annotationId]),
      },
    })),

  endAnnotationStream: (annotationId) =>
    set((state) => {
      const next = new Set(state.streamingTargets.annotations)
      next.delete(annotationId)
      return { streamingTargets: { ...state.streamingTargets, annotations: next } }
    }),

  appendStreamToken: (token) =>
    set((state) => ({
      streamingContent: state.streamingContent + token,
    })),

  finalizeStream: (content, references, agentSteps, userInputRequest, agentFileChanges) => {
    const activeConversationId = get().activeConversationId
    if (!activeConversationId) {
      set({
        isStreaming: false,
        streamingContent: "",
      })
      return
    }
    get().finalizeStreamForConversation(
      activeConversationId,
      content,
      references,
      agentSteps,
      userInputRequest,
      agentFileChanges,
    )
  },

  finalizeStreamForConversation: (conversationId, content, references, agentSteps, userInputRequest, agentFileChanges) =>
    set((state) => {
      const { conversations } = state
      if (!conversations.some((conversation) => conversation.id === conversationId)) {
        return {
          isStreaming: false,
          streamingContent: "",
        }
      }

      const newMessage: DisplayMessage = {
        id: nextId(),
        role: "assistant" as const,
        content,
        timestamp: Date.now(),
        conversationId,
        references,
        agentSteps,
        ...(agentFileChanges && agentFileChanges.length > 0 ? { agentFileChanges } : {}),
        ...(userInputRequest ? { userInputRequest } : {}),
      }

      return {
        isStreaming: false,
        streamingContent: "",
        messages: [...state.messages, newMessage],
        conversations: conversations.map((c) =>
          c.id === conversationId
            ? { ...c, updatedAt: Date.now() }
            : c
        ),
      }
    }),

  setMode: (mode) => set({ mode }),

  setIngestSource: (ingestSource) => set({ ingestSource }),

  clearMessages: () =>
    set((state) => ({
      messages: state.messages.filter(
        (m) => m.conversationId !== state.activeConversationId
      ),
    })),

  setMaxHistoryMessages: (maxHistoryMessages) => set({ maxHistoryMessages }),

  setUseWebSearch: (useWebSearch) => set({ useWebSearch }),

  setUseAnyTxtSearch: (useAnyTxtSearch) => set({ useAnyTxtSearch }),

  setAgentMode: (agentMode) => set({ agentMode }),

  setRetrievalMode: (retrievalMode) => set({ retrievalMode }),

  setSelectedSkills: (selectedSkills) =>
    set((state) => ({
      selectedSkills,
      conversations: state.activeConversationId
        ? state.conversations.map((conversation) =>
            conversation.id === state.activeConversationId
              ? { ...conversation, selectedSkills }
              : conversation
          )
        : state.conversations,
    })),

  setSelectedContextFiles: (selectedContextFiles) =>
    set((state) => ({
      selectedContextFiles,
      conversations: state.activeConversationId
        ? state.conversations.map((conversation) =>
            conversation.id === state.activeConversationId
              ? { ...conversation, contextFiles: selectedContextFiles }
              : conversation
          )
        : state.conversations,
    })),

  setManualContextFiles: (manualContextFiles) =>
    set((state) => ({
      conversations: state.activeConversationId
        ? state.conversations.map((conversation) =>
            conversation.id === state.activeConversationId
              ? { ...conversation, manualContextFiles: Array.from(new Set(manualContextFiles)) }
              : conversation
          )
        : state.conversations,
    })),

  setWikiWriteMode: (wikiWriteMode) =>
    set((state) => ({
      conversations: state.activeConversationId
        ? state.conversations.map((conversation) =>
            conversation.id === state.activeConversationId
              ? { ...conversation, wikiWriteMode }
              : conversation
          )
        : state.conversations,
    })),

  setDisabledSkills: (disabledSkills) => set({ disabledSkills }),

  removeLastAssistantMessage: () =>
    set((state) => {
      const activeId = state.activeConversationId
      if (!activeId) return state
      const activeMessages = state.messages.filter((m) => m.conversationId === activeId)
      // Find last assistant message
      const lastAssistantIdx = [...activeMessages].reverse().findIndex((m) => m.role === "assistant")
      if (lastAssistantIdx === -1) return state
      const msgToRemove = activeMessages[activeMessages.length - 1 - lastAssistantIdx]
      return {
        messages: state.messages.filter((m) => m.conversationId !== activeId || m.id !== msgToRemove.id),
      }
    }),

  createAnnotation: (parentMessageId, snippet, range) => {
    const messages = get().messages
    const parent = messages.find((m) => m.id === parentMessageId)
    if (!parent) throw new Error(`parent message not found: ${parentMessageId}`)

    const id = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const newAnn: ChatAnnotation = {
      id,
      parentMessageId,
      snippet,
      range,
      status: "open",
      createdAt: Date.now(),
      thread: [],
    }

    set({
      messages: messages.map((m) =>
        m.id === parentMessageId
          ? { ...m, annotations: [...(m.annotations ?? []), newAnn] }
          : m
      ),
    })
    return id
  },

  appendAnnotationMessage: (annotationId, role, content) => {
    const messages = get().messages
    const parentWithAnn = messages.find((message) => message.annotations?.some((annotation) => annotation.id === annotationId))
    const targetAnn = parentWithAnn?.annotations?.find((annotation) => annotation.id === annotationId)
    if (!targetAnn || targetAnn.status === "flattened") return

    const previous = targetAnn.thread[targetAnn.thread.length - 1]
    const shouldAppendToPrevious = role === "assistant" && previous?.role === "assistant"
    const nextMessage: DisplayMessage = shouldAppendToPrevious
      ? { ...previous, content: previous.content + content }
      : {
          id: nextId(),
          role,
          content,
          timestamp: Date.now(),
          conversationId: parentWithAnn?.conversationId ?? "",
          threadKind: "annotation",
        }
    set({
      messages: messages.map((message) => {
        if (!message.annotations?.some((annotation) => annotation.id === annotationId)) return message
        return {
          ...message,
          annotations: message.annotations.map((annotation) => annotation.id === annotationId
            ? { ...annotation, thread: shouldAppendToPrevious ? [...annotation.thread.slice(0, -1), nextMessage] : [...annotation.thread, nextMessage] }
            : annotation),
        }
      }),
    })
  },

  appendAnnotationAgentStep: (annotationId, step) => {
    const messages = get().messages
    const parentWithAnn = messages.find((message) => message.annotations?.some((annotation) => annotation.id === annotationId))
    const targetAnn = parentWithAnn?.annotations?.find((annotation) => annotation.id === annotationId)
    if (!targetAnn || targetAnn.status === "flattened") return

    const previous = targetAnn.thread[targetAnn.thread.length - 1]
    const assistantTurn: DisplayMessage = previous?.role === "assistant"
      ? { ...previous, agentSteps: [...(previous.agentSteps ?? []), step] }
      : {
          id: nextId(),
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          conversationId: parentWithAnn?.conversationId ?? "",
          threadKind: "annotation",
          agentSteps: [step],
        }
    set({
      messages: messages.map((message) => {
        if (!message.annotations?.some((annotation) => annotation.id === annotationId)) return message
        return {
          ...message,
          annotations: message.annotations.map((annotation) => annotation.id === annotationId
            ? { ...annotation, thread: previous?.role === "assistant" ? [...annotation.thread.slice(0, -1), assistantTurn] : [...annotation.thread, assistantTurn] }
            : annotation),
        }
      }),
    })
  },

  resolveAnnotation: (annotationId) => {
    set({
      messages: get().messages.map((m) => {
        if (!m.annotations?.some((a) => a.id === annotationId)) return m
        return {
          ...m,
          annotations: m.annotations.map((a) =>
            a.id === annotationId && a.status === "open"
              ? { ...a, status: "resolved" }
              : a
          ),
        }
      }),
    })
  },

  setAnnotationDrawerOpen: (messageId) => set({ annotationDrawerOpen: messageId }),

  saveAnnotationToWiki: (annotationId, targetPath, _content) => {
    // The actual file write is deferred — see the action's signature
    // docstring. We only persist the backlink path on the annotation
    // so the inline view (Task 6.2) can render the "📄 已保存" chip.
    // Callers should still pass the generated markdown through the
    // store so follow-up work (Agent `wiki.write_page` wiring) has
    // access to it via the call site without changing the signature.
    void _content
    set({
      messages: get().messages.map((m) => {
        if (!m.annotations?.some((a) => a.id === annotationId)) return m
        return {
          ...m,
          annotations: m.annotations.map((a) =>
            a.id === annotationId ? { ...a, wikiPath: targetPath } : a,
          ),
        }
      }),
    })
  },

  askAnnotationQuestion: async (args) => {
    // Step 1: locate the parent message. Without it we cannot anchor
    // the annotation; reject (return null) instead of throwing so the
    // popover can no-op rather than crash the trigger path. The
    // `useAnnotationActions.createAnnotation` wrapper does the same
    // try/catch — this matches that pattern.
    const parent = get().messages.find((m) => m.id === args.parentMessageId)
    if (!parent) return null
    const trimmedQuestion = args.question.trim()
    if (!trimmedQuestion) return null

    // Step 2: create the annotation row in the store via the existing
    // action. The Rust backend will receive the annotation context,
    // so we need the same id the store just generated — capture it
    // from the return value rather than minting a parallel id that
    // could drift from the canonical store record.
    const annotationId = get().createAnnotation(
      args.parentMessageId,
      args.snippet,
      args.range,
    )
    if (!annotationId) {
      console.warn("[annotation] createAnnotation returned null; aborting dispatch")
      return null
    }

    // Step 3: append the user's question to the annotation thread.
    // This is what makes the question visible in the annotation
    // inline / drawer immediately (the stream is async).
    get().appendAnnotationMessage(annotationId, "user", trimmedQuestion)

    // Step 4: register a listener for this annotation run before invoking the
    // backend. ChatSessionContent's listener is scoped to a different runId,
    // so this dedicated listener owns routing and cleanup for the annotation.
    const state = get()
    const sessionId = state.activeConversationId ?? "default"
    const runId = `ui-ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { processAnnotationEvent } = await import("@/lib/chat-annotation-stream")
    let unlisten: UnlistenFn | null = null
    const stopListening = () => {
      const current = unlisten
      unlisten = null
      current?.()
    }

    try {
      unlisten = await listen<BackendAgentEventPayload>("agent-event", (event) => {
        const result = processAnnotationEvent(
          event.payload,
          annotationId,
          runId,
          sessionId,
        )
        if (result.kind === "done") {
          stopListening()
        } else if (result.kind === "error") {
          console.warn("[annotation] stream error:", result.error)
          stopListening()
        }
      })
    } catch (err) {
      console.warn("[annotation] listener registration failed:", err)
      return annotationId
    }

    try {
      await invoke<string>("agent_start_turn_stream", {
        projectId: "current",
        request: {
          message: trimmedQuestion,
          sessionId,
          runId,
          mode: state.agentMode,
          retrievalMode: state.retrievalMode,
          stream: true,
          tools: {
            wiki: true,
            web: state.useWebSearch,
            anytxt: state.useAnyTxtSearch,
          },
          topK: state.agentMode === "deep" ? 8 : 5,
          includeContent: state.agentMode === "deep",
          history: [],
          historyExplicit: true,
          skills: [],
          contextFiles: [],
          wikiWriteMode: "confirm",
          skillMode: "auto",
          approvedShellCommands: [],
          allowUnlimitedIterations: false,
          annotation: {
            annotationId,
            parentMessageId: parent.id,
            parentMessageContent: parent.content,
            snippet: args.snippet,
            thread: [],
            status: "open",
          },
        },
      })
    } catch (err) {
      // Non-fatal: the annotation row + user question are already
      // persisted. The user can retry by submitting a follow-up.
      // The console warn keeps it discoverable for support triage.
      console.warn("[chat-store] askAnnotationQuestion invoke failed:", err)
      stopListening()
    }

    return annotationId
  },

  flattenAnnotation: (annotationId) => {
    const messages = get().messages
    const parent = messages.find((m) => m.annotations?.some((a) => a.id === annotationId))
    if (!parent) throw new Error(`annotation not found: ${annotationId}`)
    const ann = parent.annotations!.find((a) => a.id === annotationId)!
    if (ann.status === "flattened") return ann.flattenedMessageIds ?? []

    const newIds: string[] = ann.thread.map(() => nextId())
    // Once flattened, these messages live in the main conversation history,
    // so they must NOT carry the `threadKind: "annotation"` marker — that
    // marker is only valid inside `annotation.thread`, and
    // `chatMessagesToLLM` (Task 1.3) filters on it. Discard the field
    // explicitly so the copy cannot leak the thread-only flag.
    const newMainMessages: DisplayMessage[] = ann.thread.map((t, i) => {
      const { threadKind: _drop, ...rest } = t
      return {
        ...rest,
        id: newIds[i],
        conversationId: parent.conversationId,
        flattenedFromAnnotation: annotationId,
      }
    })

    set({
      messages: [
        ...messages,
        ...newMainMessages,
      ].map((m) =>
        m.id === parent.id
          ? {
              ...m,
              annotations: m.annotations!.map((a) =>
                a.id === annotationId
                  ? { ...a, status: "flattened", flattenedMessageIds: newIds }
                  : a
              ),
            }
          : m
      ),
    })
    return newIds
  },

  getActiveMessages: () => {
    const { messages, activeConversationId } = get()
    if (!activeConversationId) return []
    return messages.filter((m) => m.conversationId === activeConversationId)
  },
}))

/**
 * `chatMessagesToLLM` carries the `DisplayMessage.id` through to the wire
 * shape so callers (annotation filter, tests) can correlate filtered
 * messages back to the source conversation. `id` is purely for the
 * frontend pipeline; providers drop it before serialization.
 */
interface ChatMessageToLLM extends ChatMessage {
  id: string
}

export function chatMessagesToLLM(
  messages: DisplayMessage[],
  conversationId?: string,
): ChatMessageToLLM[] {
  return messages
    .filter((m) => !conversationId || m.conversationId === conversationId)
    .filter((m) => m.threadKind !== "annotation")
    .map((m): ChatMessageToLLM => {
      // No images → keep the legacy string shape. Providers and the
      // single-string fast paths in the translators stay unchanged,
      // and existing tests that assert `content: "..."` keep passing.
      if (!m.images || m.images.length === 0) {
        return { id: m.id, role: m.role, content: m.content }
      }
      // Images present → emit a ContentBlock[]. Text first (so the
      // model reads the prompt before the images), then one image
      // block per attachment. An empty text (image-only message)
      // still gets a text block — harmless, and keeps the shape
      // uniform.
      const blocks: ContentBlock[] = [
        { type: "text", text: m.content },
        ...m.images.map((img): ContentBlock => ({
          type: "image",
          mediaType: img.mediaType,
          dataBase64: img.dataBase64,
        })),
      ]
      return { id: m.id, role: m.role, content: blocks }
    })
}
