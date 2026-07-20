/**
 * UI-facing Agent metadata types.
 *
 * The Agent execution engine lives in Rust (`src-tauri/src/agent`). Keep this
 * file intentionally limited to display/persistence shapes used by the React UI.
 * Do not reintroduce routing, retrieval, tool execution, or prompt-building
 * logic here; those belong in the Rust Agent runtime so API, MCP, and UI callers
 * share one backend behavior.
 */

import type { DisplayMessage } from "../stores/chat-store"

/**
 * Annotation 状态机：
 *   open       - 旁注刚创建，正在追问中
 *   resolved   - 用户标记"明白"或 5 分钟无活动
 *   flattened  - 已压平插入主 conversation；此后只读
 */
export type AnnotationStatus = "open" | "resolved" | "flattened"

/**
 * 旁注：挂在某条 DisplayMessage 上、锚定到 snippet 的子对话。
 *
 * 设计要点：
 *   - thread 是自包含的 Q&A 流，不进入主 conversation 历史
 *   - chatMessagesToLLM() 必须跳过 annotation thread
 *   - range 偏移基准 UTF-16 code unit（与 String.prototype.slice 一致）
 *   - parentMessageId 永不修改；flatten 后 thread 内容会被复制追加到
 *     主 conversation 末尾，但 annotation 本身保留为只读
 */
export interface ChatAnnotation {
  id: string
  parentMessageId: string
  snippet: string
  range?: { start: number; end: number }
  status: AnnotationStatus
  createdAt: number
  /** 自包含 Q&A 流；role 限定 user / assistant */
  thread: DisplayMessage[]
  /** 创建时的可选上下文提示 */
  contextHint?: string
  /** flatten 后写入主 conversation 的新消息 id 列表（仅 flattened 时存在） */
  flattenedMessageIds?: string[]
  /** 已保存为 wiki 页面时回写的目标路径；用于反向链接 chip */
  wikiPath?: string
}

export type ChatAgentEventStage =
  | "understanding"
  | "routing"
  | "tool_call"
  | "tool_result"
  | "searching_wiki"
  | "searching_graph"
  | "searching_web"
  | "searching_anytxt"
  | "reading_context"
  | "writing"

export interface ChatAgentEvent {
  stage: ChatAgentEventStage
  query?: string
  tool?: ChatAgentToolName
  /**
   * Original backend tool name (e.g. "wiki.read_page", "shell.exec",
   * "source.search", "mcp.minimax.search") before normalization to the
   * 8-category `ChatAgentToolName` UI enum. Surfaced as a small monospace
   * badge in the activity row so users can see exactly which tool was
   * invoked, not just the generic category.
   */
  toolRaw?: string
  message?: string
  count?: number
  status?: "running" | "success" | "error" | "skipped"
  timestamp?: number
  /**
   * Raw input payload as a string (path / query / command / etc.). Surfaced
   * verbatim in the click-to-expand detail panel for tool rows; absent for
   * lifecycle stages (routing / understanding) that carry no parameters.
   */
  input?: string
  /**
   * Raw output payload as a string. Empty until the matching ToolEnd event
   * arrives. For `wiki.read_page` this is the (whitespace-collapsed, 4 000-
   * char-truncated) page body; for `shell.exec` it is the exit-code / error
   * summary; for search tools it is the count/stats line.
   */
  output?: string
}

export type ChatAgentMode = "fast" | "standard" | "deep" | "local_first"
export type ChatRetrievalMode = "standard" | "smart"

export type ChatAgentToolName =
  | "project_files"
  | "project_file_read"
  | "wiki_search"
  | "graph_search"
  | "web_search"
  | "anytxt_search"
  | "shell_exec"
  | "unknown_tool"

export interface ChatUserInputOption {
  label: string
  value: string
  description?: string
  recommended?: boolean
}

export type ChatUserInputFieldType = "single" | "multi" | "text" | "textarea" | "confirm"

export interface ChatUserInputField {
  id: string
  type: ChatUserInputFieldType
  label: string
  description?: string
  placeholder?: string
  options?: ChatUserInputOption[]
  defaultValue?: unknown
}

export interface ChatUserInputRequest {
  requestId: string
  title: string
  description?: string
  fields: ChatUserInputField[]
}

export interface ChatAgentStep {
  id: string
  type: "understanding" | "routing" | "tool_call" | "tool_result" | "final"
  tool?: ChatAgentToolName
  /** Mirror of ChatAgentEvent.toolRaw; see that field for details. */
  toolRaw?: string
  query?: string
  message?: string
  count?: number
  status?: "running" | "success" | "error" | "skipped"
  timestamp?: number
  /** Mirror of ChatAgentEvent.input; see that field for details. */
  input?: string
  /** Mirror of ChatAgentEvent.output; see that field for details. */
  output?: string
}

export interface ChatAgentFileChange {
  id: string
  path: string
  tool: string
  operation: "created" | "modified"
  additions: number
  deletions: number
  diff: string
  timestamp: number
  /** Runtime-only rollback snapshot. It is deliberately removed by persist.ts. */
  beforeContent?: string | null
  /** Runtime-only post-write snapshot used to reject stale or unsafe undo. */
  afterContent?: string
}

export interface ChatPendingWikiWrite {
  id: string
  path: string
  content: string
  existedBefore: boolean
}

export interface ChatSchemaImpactPage {
  path: string
  code: string
  message: string
  expectedDir?: string
  expectedType?: string
}

export interface ChatMemoryProposal {
  memory: {
    id: string
    kind: string
    scope: "project" | "session"
    title: string
    content: string
    confidence: "user_confirmed" | "evidence_backed" | "agent_suggested"
    reason: string
    source?: { origin: string; sessionId?: string; referencePaths?: string[] }
  }
  createdAt: number
}

export interface ChatSchemaProposal {
  id: string
  baseSchemaHash: string
  proposedSchema: string
  compiled: {
    schemaVersion: number
    contentHash: string
    typeDirs: Record<string, string>
    diagnostics: Array<{ severity: string; code: string; message: string; line?: number }>
  }
  impact: {
    schemaHash: string
    pagesScanned: number
    affectedPages: ChatSchemaImpactPage[]
    truncated: boolean
  }
  requiredDirectories: string[]
  createdAt: number
  status: "pending" | "applied" | "rejected"
}

export interface ChatShellCommandApproval {
  /** Exact command presented at the authorization boundary. */
  command: string
  decision: "approved" | "rejected" | "other"
  decidedAt: number
  /** User-supplied alternative direction for the "Other" decision. */
  instructions?: string
}
