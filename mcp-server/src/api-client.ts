export const DEFAULT_API_BASE_URL = "http://127.0.0.1:19828"

export interface LlmWikiApiClientOptions {
  baseUrl?: string
  token?: string
  fetchImpl?: typeof fetch
}

export interface ApiProject {
  id: string
  name: string
  path: string
  current: boolean
}

export interface ApiFileNode {
  name: string
  path: string
  isDir: boolean
  children?: ApiFileNode[]
}

export interface ApiSearchResult {
  path: string
  title: string
  snippet: string
  score: number
  titleMatch?: boolean
  images?: Array<{ url: string; alt: string }>
  vectorScore?: number | null
}

export interface ApiSearchResponse {
  results: ApiSearchResult[]
  mode?: string
  tokenHits?: number
  vectorHits?: number
}

export interface ApiChatReference {
  title: string
  path: string
  kind: string
  snippet?: string
  score?: number
}

export interface ApiChatToolEvent {
  tool: string
  status: string
  detail?: string
}

export interface ApiChatEvent {
  type: string
  [key: string]: unknown
}

export interface ApiChatUsage {
  promptChars?: number
  completionChars?: number
  referenceCount?: number
  toolEventCount?: number
}

export interface ApiChatResponse {
  projectId?: string
  sessionId: string
  mode?: string
  message: {
    role: string
    content: string
  }
  references: ApiChatReference[]
  toolEvents: ApiChatToolEvent[]
  events: ApiChatEvent[]
  usage?: ApiChatUsage
}

export interface ApiSchema {
  schemaVersion: number
  contentHash: string
  typeDirs: Record<string, string>
  diagnostics: Array<{ severity: string; code: string; message: string; line?: number }>
}

export interface ApiSchemaImpactReport {
  schemaHash: string
  pagesScanned: number
  affectedPages: Array<{ path: string; code: string; message: string; expectedDir?: string; expectedType?: string }>
  truncated: boolean
}

export interface ApiSchemaProposal {
  id: string
  baseSchemaHash: string
  proposedSchema: string
  compiled: ApiSchema
  impact: ApiSchemaImpactReport
  requiredDirectories: string[]
  createdAt: number
  status: string
}

export interface ApiSchemaApplyResult {
  schemaHash: string
  schemaVersion: number
  impact: ApiSchemaImpactReport
  createdDirectories: string[]
}

export interface ApiMemorySearchHit {
  memory: {
    id: string
    kind: string
    scope: "project" | "session"
    title: string
    content: string
    confidence: "user_confirmed" | "evidence_backed" | "agent_suggested"
  }
  score: number
}

export interface ApiMemoryListResponse {
  active: Array<{
    id: string
    kind: string
    scope: "project" | "session"
    title: string
    content: string
    confidence: "user_confirmed" | "evidence_backed" | "agent_suggested"
  }>
  proposals: Array<{
    id: string
    kind: string
    scope: "project" | "session"
    title: string
    content: string
  }>
  archive: Array<unknown>
}

export interface ApiMemoryImportCandidate {
  id: string
  kind: string
  scope: "project" | "session"
  title: string
  content: string
  confidence: string
  sourceLabel: string
  referencePaths: string[]
  sensitive: boolean
  duplicateOf?: string | null
}

export interface ApiMemoryImportBatch {
  id: string
  sourceFile: string
  sourceFormat: string
  candidates: ApiMemoryImportCandidate[]
  createdAt: number
}

export interface ApiGraphNode {
  id: string
  label: string
  type: string
  path?: string
  linkCount?: number
  weight?: number
}

export interface ApiGraphEdge {
  source: string
  target: string
  weight?: number
}

export type ApiReviewStatus = "unresolved" | "resolved" | "all"

export interface ApiReviewOption {
  label: string
  action: string
}

export interface ApiReviewItem {
  id: string
  type: string
  title: string
  description: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: ApiReviewOption[]
  resolved: boolean
  resolvedAction?: string
  createdAt: number
}

export interface ApiReviewsResponse {
  projectId?: string
  status: ApiReviewStatus
  count: number
  reviews: ApiReviewItem[]
}

export interface ApiFilesResponse {
  files: ApiFileNode[]
  truncated?: boolean
}

/**
 * Read-only view of a chat annotation. Mirrors the React store shape
 * (see `src/lib/chat-agent-types.ts#ChatAnnotation`); fields are optional on
 * purpose so this client stays compatible with stub responses while the
 * backend is still being designed. MCP tools that return these objects
 * must treat every field as best-effort metadata.
 */
export interface ApiAnnotation {
  id: string
  parentMessageId: string
  snippet: string
  range?: { start: number; end: number }
  status?: string
  createdAt?: number
  thread?: Array<Record<string, unknown>>
  contextHint?: string
  flattenedMessageIds?: string[]
  wikiPath?: string
  projectId?: string
  conversationId?: string
}

export interface ApiHealth {
  ok?: boolean
  status?: string
  enabled?: boolean
  mcpEnabled?: boolean
  authRequired?: boolean
  authConfigured?: boolean
  allowUnauthenticated?: boolean
  tokenSource?: string
  [key: string]: unknown
}

export function normalizeBaseUrl(value?: string): string {
  const raw = (value ?? DEFAULT_API_BASE_URL).trim() || DEFAULT_API_BASE_URL
  return raw.replace(/\/+$/, "")
}

function apiPath(path: string): string {
  return path.startsWith("/api/v1") ? path : `/api/v1${path.startsWith("/") ? path : `/${path}`}`
}

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected JSON object`)
  }
  return value as Record<string, unknown>
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export class LlmWikiApiClient {
  private readonly baseUrl: string
  private readonly token?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: LlmWikiApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.LLM_WIKI_API_BASE_URL)
    this.token = options.token ?? process.env.LLM_WIKI_API_TOKEN
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async health(): Promise<ApiHealth> {
    return this.request("/health", { auth: false }) as Promise<ApiHealth>
  }

  async projects(): Promise<{ projects: ApiProject[]; currentProject: ApiProject | null }> {
    const json = await this.request("/projects")
    const projects = Array.isArray(json.projects) ? json.projects.map(parseProject) : []
    const currentProject = json.currentProject ? parseProject(json.currentProject) : null
    return { projects, currentProject }
  }

  async files(projectId = "current", options: { root?: "wiki" | "sources" | "all"; recursive?: boolean; maxFiles?: number } = {}): Promise<ApiFilesResponse> {
    const params = new URLSearchParams()
    params.set("root", options.root ?? "wiki")
    if (options.recursive !== undefined) params.set("recursive", String(options.recursive))
    if (options.maxFiles !== undefined) params.set("maxFiles", String(options.maxFiles))
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/files?${params.toString()}`)
    return {
      files: Array.isArray(json.files) ? json.files.map(parseFileNode) : [],
      truncated: json.truncated === true,
    }
  }

  async fileContent(projectId = "current", path: string): Promise<{ path: string; content: string }> {
    const params = new URLSearchParams({ path })
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/files/content?${params.toString()}`)
    return {
      path: typeof json.path === "string" ? json.path : path,
      content: typeof json.content === "string" ? json.content : "",
    }
  }

  async reviews(projectId = "current", options: { status?: ApiReviewStatus; type?: string; limit?: number } = {}): Promise<ApiReviewsResponse> {
    const params = new URLSearchParams()
    if (options.status) params.set("status", options.status)
    if (options.type) params.set("type", options.type)
    if (options.limit !== undefined) params.set("limit", String(options.limit))
    const suffix = params.toString() ? `?${params.toString()}` : ""
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/reviews${suffix}`)
    const reviews = Array.isArray(json.reviews) ? json.reviews.map(parseReviewItem) : []
    return {
      projectId: typeof json.projectId === "string" ? json.projectId : undefined,
      status: parseReviewStatus(json.status),
      count: numberOrUndefined(json.count) ?? reviews.length,
      reviews,
    }
  }

  async search(projectId = "current", query: string, options: { topK?: number; includeContent?: boolean } = {}): Promise<ApiSearchResponse> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/search`, {
      method: "POST",
      body: {
        query,
        topK: options.topK,
        includeContent: options.includeContent,
      },
    })
    return {
      results: Array.isArray(json.results) ? json.results.map(parseSearchResult) : [],
      mode: typeof json.mode === "string" ? json.mode : undefined,
      tokenHits: numberOrUndefined(json.tokenHits),
      vectorHits: numberOrUndefined(json.vectorHits),
    }
  }

  async chat(projectId = "current", message: string, options: { sessionId?: string; mode?: string; topK?: number; includeContent?: boolean; wiki?: boolean; web?: boolean; anytxt?: boolean; skills?: string[]; persistSession?: boolean } = {}): Promise<ApiChatResponse> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/chat`, {
      method: "POST",
      body: {
        message,
        sessionId: options.sessionId,
        persistSession: options.persistSession,
        mode: options.mode,
        topK: options.topK,
        includeContent: options.includeContent,
        tools: {
          wiki: options.wiki ?? true,
          web: options.web ?? false,
          anytxt: options.anytxt ?? false,
        },
        skills: options.skills,
      },
    })
    const msg = requireObject(json.message, "chat message")
    return {
      projectId: typeof json.projectId === "string" ? json.projectId : undefined,
      sessionId: typeof json.sessionId === "string" ? json.sessionId : "",
      mode: typeof json.mode === "string" ? json.mode : undefined,
      message: {
        role: typeof msg.role === "string" ? msg.role : "assistant",
        content: typeof msg.content === "string" ? msg.content : "",
      },
      references: Array.isArray(json.references) ? json.references.map(parseChatReference) : [],
      toolEvents: Array.isArray(json.toolEvents) ? json.toolEvents.map(parseChatToolEvent) : [],
      events: Array.isArray(json.events) ? json.events.map(parseChatEvent) : [],
      usage: parseChatUsage(json.usage),
    }
  }

  async cancelChat(projectId = "current", sessionId: string): Promise<{ sessionId: string; cancelled: boolean }> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
    })
    return {
      sessionId: typeof json.sessionId === "string" ? json.sessionId : sessionId,
      cancelled: json.cancelled === true,
    }
  }

  async schema(projectId = "current"): Promise<ApiSchema> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/schema`)
    return parseSchema(json.schema)
  }

  async memorySearch(projectId = "current", query = "", options: { kind?: string; limit?: number } = {}): Promise<ApiMemorySearchHit[]> {
    const params = new URLSearchParams({ query })
    if (options.kind) params.set("kind", options.kind)
    if (options.limit !== undefined) params.set("limit", String(options.limit))
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/memory/search?${params.toString()}`)
    return Array.isArray(json.hits) ? json.hits.map(parseMemorySearchHit) : []
  }

  async memoryList(projectId = "current"): Promise<ApiMemoryListResponse> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/memory/list`)
    return {
      active: Array.isArray(json.active) ? json.active.map(parseMemoryEntry) : [],
      proposals: Array.isArray(json.proposals) ? json.proposals.map(parseMemoryEntry) : [],
      archive: Array.isArray(json.archive) ? json.archive : [],
    }
  }

  async memoryAcceptProposal(projectId: string, memoryId: string): Promise<unknown> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/memory/proposals/${encodeURIComponent(memoryId)}/accept`, {
      method: "POST",
    })
  }

  async memoryRejectProposal(projectId: string, memoryId: string, reason = "rejected via MCP"): Promise<unknown> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/memory/proposals/${encodeURIComponent(memoryId)}/reject`, {
      method: "POST",
      body: { reason },
    })
  }

  async memoryArchive(projectId: string, memoryId: string, reason = "archived via MCP"): Promise<unknown> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/memory/${encodeURIComponent(memoryId)}/archive`, {
      method: "POST",
      body: { reason },
    })
  }

  async memoryRedact(projectId: string, memoryId: string, reason = "redacted via MCP"): Promise<unknown> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/memory/${encodeURIComponent(memoryId)}/redact`, {
      method: "POST",
      body: { reason },
    })
  }

  async memoryImportParse(projectId: string, sourceFormat: string, sourceLabel: string, raw: string): Promise<ApiMemoryImportBatch> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/memory/imports`, {
      method: "POST",
      body: { sourceFormat, sourceLabel, raw },
    })
    return parseMemoryImportBatch(json.batch)
  }

  async memoryImportAccept(projectId: string, batchId: string, candidateId: string, sessionId: string): Promise<unknown> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/memory/imports/${encodeURIComponent(batchId)}/accept`, {
      method: "POST",
      body: { sessionId, candidateId },
    })
  }

  async memoryImportList(projectId = "current"): Promise<ApiMemoryImportBatch[]> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/memory/imports`)
    return Array.isArray(json.batches) ? json.batches.map(parseMemoryImportBatch) : []
  }

  async memoryImportDiscard(projectId: string, batchId: string): Promise<unknown> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/memory/imports/${encodeURIComponent(batchId)}`, {
      method: "DELETE",
    })
  }

  async schemaAudit(projectId = "current"): Promise<ApiSchemaImpactReport> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/schema/audit`)
    return parseSchemaImpact(json.audit)
  }

  async createSchemaProposal(projectId: string, sessionId: string, proposedSchema: string): Promise<ApiSchemaProposal> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/schema/proposals`, {
      method: "POST",
      body: { sessionId, proposedSchema },
    })
    return parseSchemaProposal(json.proposal)
  }

  async applySchemaProposal(projectId: string, proposalId: string, sessionId: string, expectedSchemaHash: string): Promise<ApiSchemaApplyResult> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/schema/proposals/${encodeURIComponent(proposalId)}/apply`, {
      method: "POST",
      body: { sessionId, expectedSchemaHash },
    })
    return parseSchemaApplyResult(json.result)
  }

  async rejectSchemaProposal(projectId: string, proposalId: string, sessionId: string): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(projectId)}/schema/proposals/${encodeURIComponent(proposalId)}/reject`, {
      method: "POST",
      body: { sessionId },
    })
  }

  async graph(projectId = "current", options: { q?: string; nodeType?: string; limit?: number } = {}): Promise<{ nodes: ApiGraphNode[]; edges: ApiGraphEdge[] }> {
    const params = new URLSearchParams()
    if (options.q) params.set("q", options.q)
    if (options.nodeType) params.set("nodeType", options.nodeType)
    if (options.limit !== undefined) params.set("limit", String(options.limit))
    const suffix = params.toString() ? `?${params.toString()}` : ""
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/graph${suffix}`)
    return {
      nodes: Array.isArray(json.nodes) ? json.nodes.map(parseGraphNode) : [],
      edges: Array.isArray(json.edges) ? json.edges.map(parseGraphEdge) : [],
    }
  }

  async rescan(projectId = "current"): Promise<Record<string, unknown>> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/sources/rescan`, {
      method: "POST",
    })
  }

  /**
   * Stub: list all chat annotations for a conversation. The Rust API does not
   * yet expose a dedicated annotation endpoint (see Task 7.1 Path 1); the
   * persisted annotations live in the chat history JSON files and are not
   * reachable via `src-tauri/src/api_server.rs` as of the current phase.
   * Throws so missing wiring is loud instead of silently returning `[]`.
   */
  async listAnnotations(conversationId: string): Promise<ApiAnnotation[]> {
    if (!conversationId || typeof conversationId !== "string") {
      throw new Error("listAnnotations: conversationId is required")
    }
    throw new Error(
      "listAnnotations: backend endpoint not yet exposed (Task 7.1 Path 1 stub)",
    )
  }

  /**
   * Stub: read a single annotation's full thread by id. Same rationale as
   * `listAnnotations` — the Rust API does not yet expose annotation reads.
   */
  async readAnnotation(annotationId: string): Promise<ApiAnnotation> {
    if (!annotationId || typeof annotationId !== "string") {
      throw new Error("readAnnotation: annotationId is required")
    }
    throw new Error(
      "readAnnotation: backend endpoint not yet exposed (Task 7.1 Path 1 stub)",
    )
  }

  private async request(path: string, options: { method?: "DELETE" | "GET" | "POST"; body?: unknown; auth?: boolean } = {}): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${apiPath(path)}`
    const headers: Record<string, string> = { Accept: "application/json" }
    if (options.auth !== false && this.token?.trim()) {
      headers.Authorization = `Bearer ${this.token.trim()}`
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json"

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch (err) {
      throw new Error(`LLM Wiki API request failed. Is the desktop app running? ${err instanceof Error ? err.message : String(err)}`)
    }

    const text = await response.text()
    let json: Record<string, unknown>
    try {
      json = text ? requireObject(JSON.parse(text), "LLM Wiki API response") : {}
    } catch (err) {
      throw new Error(`LLM Wiki API returned non-JSON response (${response.status}): ${text.slice(0, 300)}${err instanceof Error ? ` (${err.message})` : ""}`)
    }

    if (!response.ok || json.ok === false) {
      const message = typeof json.error === "string" ? json.error : response.statusText
      throw new Error(`LLM Wiki API ${response.status}: ${message}`)
    }
    return json
  }
}

function parseSchema(value: unknown): ApiSchema {
  const obj = requireObject(value, "schema")
  const typeDirs = obj.typeDirs && typeof obj.typeDirs === "object" && !Array.isArray(obj.typeDirs)
    ? Object.fromEntries(Object.entries(obj.typeDirs).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {}
  return {
    schemaVersion: numberOrUndefined(obj.schemaVersion) ?? 1,
    contentHash: String(obj.contentHash ?? ""),
    typeDirs,
    diagnostics: Array.isArray(obj.diagnostics) ? obj.diagnostics.map((item) => {
      const diagnostic = requireObject(item, "schema diagnostic")
      return { severity: String(diagnostic.severity ?? "warning"), code: String(diagnostic.code ?? "unknown"), message: String(diagnostic.message ?? ""), ...(numberOrUndefined(diagnostic.line) !== undefined ? { line: numberOrUndefined(diagnostic.line) } : {}) }
    }) : [],
  }
}

function parseSchemaImpact(value: unknown): ApiSchemaImpactReport {
  const obj = requireObject(value, "schema audit")
  return {
    schemaHash: String(obj.schemaHash ?? ""),
    pagesScanned: numberOrUndefined(obj.pagesScanned) ?? 0,
    affectedPages: Array.isArray(obj.affectedPages) ? obj.affectedPages.map((item) => {
      const page = requireObject(item, "schema affected page")
      return { path: String(page.path ?? ""), code: String(page.code ?? "unknown"), message: String(page.message ?? ""), ...(typeof page.expectedDir === "string" ? { expectedDir: page.expectedDir } : {}), ...(typeof page.expectedType === "string" ? { expectedType: page.expectedType } : {}) }
    }) : [],
    truncated: obj.truncated === true,
  }
}

function parseSchemaProposal(value: unknown): ApiSchemaProposal {
  const obj = requireObject(value, "schema proposal")
  return {
    id: String(obj.id ?? ""), baseSchemaHash: String(obj.baseSchemaHash ?? ""), proposedSchema: String(obj.proposedSchema ?? ""), compiled: parseSchema(obj.compiled), impact: parseSchemaImpact(obj.impact), requiredDirectories: Array.isArray(obj.requiredDirectories) ? obj.requiredDirectories.filter((item): item is string => typeof item === "string") : [], createdAt: numberOrUndefined(obj.createdAt) ?? 0, status: String(obj.status ?? "pending"),
  }
}

function parseSchemaApplyResult(value: unknown): ApiSchemaApplyResult {
  const obj = requireObject(value, "schema apply result")
  return { schemaHash: String(obj.schemaHash ?? ""), schemaVersion: numberOrUndefined(obj.schemaVersion) ?? 1, impact: parseSchemaImpact(obj.impact), createdDirectories: Array.isArray(obj.createdDirectories) ? obj.createdDirectories.filter((item): item is string => typeof item === "string") : [] }
}

function parseMemoryEntry(value: unknown): ApiMemoryListResponse["active"][number] {
  const obj = requireObject(value, "memory entry")
  return {
    id: String(obj.id ?? ""),
    kind: String(obj.kind ?? "user_preference"),
    scope: (obj.scope === "session" ? "session" : "project") as "project" | "session",
    title: String(obj.title ?? ""),
    content: String(obj.content ?? ""),
    confidence: normalizeConfidence(obj.confidence),
  }
}

function normalizeConfidence(value: unknown): "user_confirmed" | "evidence_backed" | "agent_suggested" {
  if (value === "evidence_backed") return "evidence_backed"
  if (value === "agent_suggested") return "agent_suggested"
  return "user_confirmed"
}

function parseMemorySearchHit(value: unknown): ApiMemorySearchHit {
  const entry = parseMemoryEntry(value)
  const obj = requireObject(value, "memory hit")
  return { memory: entry, score: numberOrUndefined(obj.score) ?? 0 }
}

function parseMemoryImportCandidate(value: unknown): ApiMemoryImportCandidate {
  const obj = requireObject(value, "memory import candidate")
  return {
    id: String(obj.id ?? ""),
    kind: String(obj.kind ?? "user_preference"),
    scope: (obj.scope === "session" ? "session" : "project") as "project" | "session",
    title: String(obj.title ?? ""),
    content: String(obj.content ?? ""),
    confidence: String(obj.confidence ?? "user_confirmed"),
    sourceLabel: String(obj.sourceLabel ?? ""),
    referencePaths: Array.isArray(obj.referencePaths) ? obj.referencePaths.filter((item): item is string => typeof item === "string") : [],
    sensitive: obj.sensitive === true,
    duplicateOf: typeof obj.duplicateOf === "string" ? obj.duplicateOf : null,
  }
}

function parseMemoryImportBatch(value: unknown): ApiMemoryImportBatch {
  const obj = requireObject(value, "memory import batch")
  return {
    id: String(obj.id ?? ""),
    sourceFile: String(obj.sourceFile ?? ""),
    sourceFormat: String(obj.sourceFormat ?? ""),
    createdAt: numberOrUndefined(obj.createdAt) ?? 0,
    candidates: Array.isArray(obj.candidates) ? obj.candidates.map(parseMemoryImportCandidate) : [],
  }
}

function parseProject(value: unknown): ApiProject {
  const obj = requireObject(value, "project")
  return {
    id: String(obj.id ?? ""),
    name: String(obj.name ?? ""),
    path: String(obj.path ?? ""),
    current: obj.current === true,
  }
}

function parseFileNode(value: unknown): ApiFileNode {
  const obj = requireObject(value, "file node")
  const children = Array.isArray(obj.children) ? obj.children.map(parseFileNode) : undefined
  return {
    name: String(obj.name ?? ""),
    path: String(obj.path ?? ""),
    isDir: obj.isDir === true || obj.is_dir === true,
    ...(children ? { children } : {}),
  }
}

function parseSearchResult(value: unknown): ApiSearchResult {
  const obj = requireObject(value, "search result")
  return {
    path: String(obj.path ?? ""),
    title: String(obj.title ?? ""),
    snippet: String(obj.snippet ?? ""),
    score: numberOrUndefined(obj.score) ?? 0,
    titleMatch: obj.titleMatch === true,
    images: Array.isArray(obj.images) ? obj.images.map((image) => {
      const item = requireObject(image, "image")
      return { url: String(item.url ?? ""), alt: String(item.alt ?? "") }
    }) : [],
    vectorScore: numberOrUndefined(obj.vectorScore) ?? null,
  }
}

function parseChatReference(value: unknown): ApiChatReference {
  const obj = requireObject(value, "chat reference")
  return {
    title: String(obj.title ?? ""),
    path: String(obj.path ?? ""),
    kind: String(obj.kind ?? "wiki"),
    snippet: typeof obj.snippet === "string" ? obj.snippet : undefined,
    score: numberOrUndefined(obj.score),
  }
}

function parseChatToolEvent(value: unknown): ApiChatToolEvent {
  const obj = requireObject(value, "chat tool event")
  return {
    tool: String(obj.tool ?? ""),
    status: String(obj.status ?? ""),
    detail: typeof obj.detail === "string" ? obj.detail : undefined,
  }
}

function parseChatEvent(value: unknown): ApiChatEvent {
  const obj = requireObject(value, "chat event")
  return {
    ...obj,
    type: String(obj.type ?? ""),
  }
}

function parseChatUsage(value: unknown): ApiChatUsage | undefined {
  if (value === undefined || value === null) return undefined
  const obj = requireObject(value, "chat usage")
  return {
    promptChars: numberOrUndefined(obj.promptChars),
    completionChars: numberOrUndefined(obj.completionChars),
    referenceCount: numberOrUndefined(obj.referenceCount),
    toolEventCount: numberOrUndefined(obj.toolEventCount),
  }
}

function parseReviewStatus(value: unknown): ApiReviewStatus {
  return value === "resolved" || value === "all" ? value : "unresolved"
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => String(item))
}

function parseReviewItem(value: unknown): ApiReviewItem {
  const obj = requireObject(value, "review item")
  return {
    id: String(obj.id ?? ""),
    type: String(obj.type ?? ""),
    title: String(obj.title ?? ""),
    description: String(obj.description ?? ""),
    sourcePath: typeof obj.sourcePath === "string" ? obj.sourcePath : undefined,
    affectedPages: stringArray(obj.affectedPages),
    searchQueries: stringArray(obj.searchQueries),
    options: Array.isArray(obj.options) ? obj.options.map((option) => {
      const item = requireObject(option, "review option")
      return { label: String(item.label ?? ""), action: String(item.action ?? "") }
    }) : [],
    resolved: obj.resolved === true,
    resolvedAction: typeof obj.resolvedAction === "string" ? obj.resolvedAction : undefined,
    createdAt: numberOrUndefined(obj.createdAt) ?? 0,
  }
}

function parseGraphNode(value: unknown): ApiGraphNode {
  const obj = requireObject(value, "graph node")
  return {
    id: String(obj.id ?? ""),
    label: String(obj.label ?? ""),
    type: String(obj.nodeType ?? obj.type ?? "other"),
    path: typeof obj.path === "string" ? obj.path : undefined,
    linkCount: numberOrUndefined(obj.linkCount),
    weight: numberOrUndefined(obj.weight),
  }
}

function parseGraphEdge(value: unknown): ApiGraphEdge {
  const obj = requireObject(value, "graph edge")
  return {
    source: String(obj.source ?? ""),
    target: String(obj.target ?? ""),
    weight: numberOrUndefined(obj.weight),
  }
}
