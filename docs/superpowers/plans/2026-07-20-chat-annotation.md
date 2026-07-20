# Chat Annotation 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Chat 中支持对 assistant 长回复某个 snippet 发起"单独追问"，追问结果以 Annotation（旁注）形式永久挂在原 message 上不打断主流；可切换到右侧抽屉、可手动"压平"插入主 conversation、可保存为 Wiki 页面。

**Architecture:** 在 `DisplayMessage` 上挂载 `ChatAnnotation[]`，annotation 是带原 message 锚点的子对话；Rust `AgentRuntime` 接受可选 `AnnotationContext`，context 拼装阶段注入不可裁剪的 annotation 引导块（父 message 全文 + 选区 + thread 历史）；流式事件加可选 `annotation_id` 字段做路由。Open → Resolved → Flattened 状态机；MCP 第一版只读；保存到 Wiki 走现有 `pending_writes` 确认链。

**Tech Stack:** React 19、TypeScript strict、Zustand、Tailwind、Radix ContextMenu/Popover、Tauri v2、Rust、Serde、Vitest、Cargo test。

## Global Constraints

- 持久化路径与 IPC payload 使用 `/`；前端路径处理复用 `src/lib/path-utils.ts`。
- 不在 React 里重写 Agent 核心：annotation-followup 走 Rust `AgentRuntime`，context 注入在 `agent/context.rs`；MCP/API 沿用同一 backend。
- 流式期间不卸载 `ChatSessionContent`（CLAUDE.md 硬约束）；annotation 与主 turn 的流式通过 `streamingTargets: { main, annotations: Set }` 正交建模。
- 右栏互斥：annotation 抽屉与 `WikiPageAssistant` / `ResearchStore` 通过 `rightPane` 状态机管理。
- 新增 Tauri command 必须经 `run_guarded` / `run_guarded_async` 包裹。
- 新增翻译键须同步 `src/i18n/en.json` 与 `src/i18n/zh.json`，并通过 i18n parity 测试。
- TypeScript 与 Rust 均保持 strict/unused 检查；不新增 prod 依赖；UI 库优先用 Radix。
- 不修改或覆盖当前工作区中与该功能无关的用户改动。
- `range: { start, end }` 偏移基准：**UTF-16 code unit**（与 JS `String.prototype.slice` 一致）；Rust 端 boundary 处显式转换并加 boundary 单测。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/lib/chat-agent-types.ts` | 新增 `ChatAnnotation`、`AnnotationStatus` 类型。 |
| `src/stores/chat-store.ts` | annotation CRUD；`streamingTargets` 状态；`chatMessagesToLLM()` 过滤 annotation thread。 |
| `src/stores/chat-store.test.ts` | annotation 状态机 + 隔离 + streaming 测试。 |
| `src/lib/persist.ts`、`src/lib/auto-save.ts` | `annotations?` 字段 round-trip；不 bump schemaVersion。 |
| `src/components/chat/annotation/selection-utils.ts`（新目录） | `window.getSelection()` 封装、range 偏移计算。 |
| `src/components/chat/annotation/ChatAnnotationTrigger.tsx` | 双入口触发器（右键菜单 + 按段 ? 按钮）。 |
| `src/components/chat/annotation/ChatAnnotationInline.tsx` | 内联折叠视图。 |
| `src/components/chat/annotation/ChatAnnotationThread.tsx` | 复用 `chat-message.tsx` 的 thread 渲染。 |
| `src/components/chat/annotation/ChatAnnotationDrawer.tsx` | 右侧抽屉视图。 |
| `src/components/chat/annotation/ChatAnnotationList.tsx` | 抽屉内的 annotation 列表。 |
| `src/components/chat/annotation/ChatAnnotationFlattenDialog.tsx` | flatten 确认弹窗。 |
| `src/components/chat/annotation/SaveAnnotationToWikiDialog.tsx` | 保存到 Wiki 弹窗。 |
| `src/components/chat/annotation/useAnnotationActions.ts` | action hooks（create/followup/flatten/resolve）。 |
| `src/components/chat/annotation/useAnnotationShortcuts.ts` | 键盘快捷键 hook。 |
| `src/components/chat/chat-message.tsx` | 加 `onAnnotationCreate` 回调 + `selectionContainerRef` 转发；按段 ? 按钮 host。 |
| `src/components/chat/chat-session-content.tsx` | 流式事件路由到 annotation；annotation 创建/挂载入口。 |
| `src/components/layout/right-pane-store.ts`（或既有） | 新增 pane kind `'annotation-drawer'`，与 WikiPageAssistant/ResearchStore 互斥。 |
| `src/commands/agent.ts` | 封装 `agent_chat_annotation_followup` IPC。 |
| `src/i18n/en.json`、`src/i18n/zh.json` | annotation 全部文案。 |
| `src-tauri/src/agent/types.rs` | `AnnotationStatus`、`AnnotationContext` 类型 + serde。 |
| `src-tauri/src/agent/context.rs` | annotation 引导块注入（不可裁剪优先级）。 |
| `src-tauri/src/agent/runtime.rs` | `AgentRunRequest.annotation: Option<AnnotationContext>`；cancellation key 扩展。 |
| `src-tauri/src/agent/events.rs` | 流式事件加 `annotation_id` 字段。 |
| `src-tauri/src/commands/annotation.rs`（新） | `agent_chat_annotation_followup` Tauri command（`run_guarded_async`）。 |
| `src-tauri/src/api_server.rs` | chat endpoint 接受 `annotation: Option<...>` 字段。 |
| `src-tauri/src/lib.rs` | 注册 `agent_chat_annotation_followup` command。 |
| `mcp-server/src/index.ts`、`mcp-server/src/api-client.ts` | 暴露 `chat.annotation.list` / `chat.annotation.read`。 |

---

## Phase 1：数据模型 + 持久化

### Task 1.1: ChatAnnotation 类型定义

**Files:**
- Modify: `src/lib/chat-agent-types.ts:1-15`（在文件顶部 import 区之后、第一个 interface 之前）

**Interfaces:**
- Produces `ChatAnnotation`、`AnnotationStatus` 类型（被后续所有任务消费）。

- [ ] **Step 1: 写 failing type-level test**

在 `src/lib/chat-agent-types.test-d.ts`（新建 type-only 测试文件，仅做编译期断言）：

```typescript
import type { ChatAnnotation, AnnotationStatus } from "./chat-agent-types"
import type { DisplayMessage } from "../stores/chat-store"

declare const ann: ChatAnnotation
declare const msg: DisplayMessage

// ChatAnnotation 必须有这些字段
const _id: string = ann.id
const _parent: string = ann.parentMessageId
const _snippet: string = ann.snippet
const _status: AnnotationStatus = ann.status
const _created: number = ann.createdAt
const _thread: DisplayMessage[] = ann.thread

// status 必须是三个值之一
const _open: AnnotationStatus = "open"
const _resolved: AnnotationStatus = "resolved"
const _flattened: AnnotationStatus = "flattened"

// range 可选，但若有必须含 start/end
const _start: number = ann.range!.start
const _end: number = ann.range!.end

// DisplayMessage.annotations 可选
const _annos: ChatAnnotation[] | undefined = msg.annotations
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run --typecheck.only --environment node src/lib/chat-agent-types.test-d.ts`
Expected: FAIL（`ChatAnnotation` / `AnnotationStatus` 未导出）。

- [ ] **Step 3: 在 chat-agent-types.ts 中新增类型**

```typescript
// src/lib/chat-agent-types.ts（追加到现有 export 之前）

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
```

注意：`DisplayMessage` 在 `chat-agent-types.ts` 中**不**导入，避免循环依赖。改成**从 chat-store.ts 反向导入**：

```typescript
// src/lib/chat-agent-types.ts 文件顶部
import type { DisplayMessage } from "../stores/chat-store"
```

如果项目当前 ESLint / tsc 配置禁止跨目录 type-only 循环引用，先把 `DisplayMessage` 的 interface 搬到 `chat-agent-types.ts`（仅搬 interface，不搬实现），让 chat-store.ts 从 chat-agent-types 导入。在迁移时记录到 `chat-store.ts` 顶部注释。

- [ ] **Step 4: 在 DisplayMessage 上加 annotations 字段**

```typescript
// src/stores/chat-store.ts:40-54（在 DisplayMessage 接口里加一行）
export interface DisplayMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: number
  conversationId: string
  references?: MessageReference[]
  agentSteps?: ChatAgentStep[]
  agentFileChanges?: ChatAgentFileChange[]
  userInputRequest?: ChatUserInputRequest
  images?: MessageImage[]
  contextFiles?: string[]
  pendingWikiWrite?: ChatPendingWikiWrite
  shellCommandApproval?: ChatShellCommandApproval
  /** 旁注：snippet 锚定的子对话数组 */
  annotations?: ChatAnnotation[]
}
```

并在 chat-store.ts 顶部 import：
```typescript
import type { ChatAnnotation } from "./chat-agent-types"
```

- [ ] **Step 5: 跑 typecheck，确认通过**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 6: 提交**

```bash
git add src/lib/chat-agent-types.ts src/stores/chat-store.ts
git commit -m "feat(chat-types): add ChatAnnotation + AnnotationStatus types"
```

### Task 1.2: chat-store annotation CRUD

**Files:**
- Modify: `src/stores/chat-store.ts:55-105`（ChatState interface 加 action）
- Modify: `src/stores/chat-store.ts:118-end`（实现）
- Modify: `src/stores/chat-store.test.ts`（追加测试）

**Interfaces:**
- Produces:
  - `createAnnotation(parentMessageId, snippet, range?): string` — 返回新 annotation id
  - `appendAnnotationMessage(annotationId, role, content): void`
  - `resolveAnnotation(annotationId): void`
  - `flattenAnnotation(annotationId): string[]` — 返回追加到主 conversation 的新 message ids

- [ ] **Step 1: 写 failing tests**

在 `src/stores/chat-store.test.ts` 末尾追加：

```typescript
import { useChatStore } from "./chat-store"

describe("annotation CRUD", () => {
  beforeEach(() => useChatStore.setState({
    conversations: [], activeConversationId: null, messages: [],
    isStreaming: false, streamingContent: "",
  }))

  it("createAnnotation appends to parent message", () => {
    const store = useChatStore.getState()
    store.createConversation()
    const convId = useChatStore.getState().activeConversationId!
    store.addMessageToConversation(convId, "assistant", "Long answer A1, A2, A3.")
    const parentId = useChatStore.getState().messages[0].id

    const annId = store.createAnnotation(parentId, "A1", { start: 13, end: 15 })

    const msg = useChatStore.getState().messages.find(m => m.id === parentId)!
    expect(msg.annotations).toHaveLength(1)
    expect(msg.annotations![0].id).toBe(annId)
    expect(msg.annotations![0].status).toBe("open")
    expect(msg.annotations![0].snippet).toBe("A1")
    expect(msg.annotations![0].range).toEqual({ start: 13, end: 15 })
    expect(msg.annotations![0].thread).toEqual([])
  })

  it("appendAnnotationMessage pushes into thread", () => {
    const store = useChatStore.getState()
    store.createConversation()
    const convId = useChatStore.getState().activeConversationId!
    store.addMessageToConversation(convId, "assistant", "Body")
    const parentId = useChatStore.getState().messages[0].id
    const annId = store.createAnnotation(parentId, "snippet")

    store.appendAnnotationMessage(annId, "user", "What's A1?")
    store.appendAnnotationMessage(annId, "assistant", "A1 means ...")

    const ann = useChatStore.getState().messages
      .find(m => m.id === parentId)!.annotations![0]
    expect(ann.thread).toHaveLength(2)
    expect(ann.thread[0].role).toBe("user")
    expect(ann.thread[1].role).toBe("assistant")
  })

  it("resolveAnnotation transitions open -> resolved", () => {
    const store = useChatStore.getState()
    store.createConversation()
    const convId = useChatStore.getState().activeConversationId!
    store.addMessageToConversation(convId, "assistant", "Body")
    const parentId = useChatStore.getState().messages[0].id
    const annId = store.createAnnotation(parentId, "snippet")

    store.resolveAnnotation(annId)

    const ann = useChatStore.getState().messages
      .find(m => m.id === parentId)!.annotations![0]
    expect(ann.status).toBe("resolved")
  })

  it("flattenAnnotation copies thread into main conversation and marks flattened", () => {
    const store = useChatStore.getState()
    store.createConversation()
    const convId = useChatStore.getState().activeConversationId!
    store.addMessageToConversation(convId, "assistant", "Body")
    const parentId = useChatStore.getState().messages[0].id
    const annId = store.createAnnotation(parentId, "snippet")
    store.appendAnnotationMessage(annId, "user", "Q?")
    store.appendAnnotationMessage(annId, "assistant", "A.")

    const newIds = store.flattenAnnotation(annId)

    const ann = useChatStore.getState().messages
      .find(m => m.id === parentId)!.annotations![0]
    expect(ann.status).toBe("flattened")
    expect(ann.flattenedMessageIds).toEqual(newIds)
    expect(useChatStore.getState().messages.length).toBeGreaterThanOrEqual(3) // parent + 2 new

    // 主 conversation 末尾的新消息，flattenedFromAnnotation 标记
    const last2 = useChatStore.getState().messages.slice(-2)
    expect(last2[0].role).toBe("user")
    expect(last2[1].role).toBe("assistant")
    expect((last2[0] as any).flattenedFromAnnotation).toBe(annId)
    expect((last2[1] as any).flattenedFromAnnotation).toBe(annId)
  })

  it("createAnnotation throws if parent message not found", () => {
    expect(() =>
      useChatStore.getState().createAnnotation("nonexistent", "x")
    ).toThrow(/parent message not found/)
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run --environment node src/stores/chat-store.test.ts -t "annotation"`
Expected: 5 个测试全部 FAIL（`createAnnotation is not a function`）。

- [ ] **Step 3: 在 ChatState interface 加 action 签名**

```typescript
// src/stores/chat-store.ts:55-105（追加到 Message management 区段）

  // Annotation management
  createAnnotation: (parentMessageId: string, snippet: string, range?: { start: number; end: number }) => string
  appendAnnotationMessage: (annotationId: string, role: "user" | "assistant", content: string) => void
  resolveAnnotation: (annotationId: string) => void
  flattenAnnotation: (annotationId: string) => string[]
```

- [ ] **Step 4: 实现 actions**

在 `useChatStore = create<ChatState>((set, get) => ({` 的实现体里追加（找一个合适位置，例如 removeLastAssistantMessage 旁边）：

```typescript
  createAnnotation: (parentMessageId, snippet, range) => {
    const messages = get().messages
    const parent = messages.find(m => m.id === parentMessageId)
    if (!parent) throw new Error(`parent message not found: ${parentMessageId}`)

    const id = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const newAnn: ChatAnnotation = {
      id, parentMessageId, snippet, range,
      status: "open", createdAt: Date.now(), thread: [],
    }

    set({
      messages: messages.map(m =>
        m.id === parentMessageId
          ? { ...m, annotations: [...(m.annotations ?? []), newAnn] }
          : m
      ),
    })
    return id
  },

  appendAnnotationMessage: (annotationId, role, content) => {
    const messageCounter = (typeof (appendAnnotationMessage as any).counter === "number"
      ? (appendAnnotationMessage as any).counter : -1) + 1
    ;(appendAnnotationMessage as any).counter = messageCounter
    const newMsg: DisplayMessage = {
      id: `msg_${Date.now()}_${messageCounter}_${Math.random().toString(36).slice(2, 8)}`,
      role, content,
      timestamp: Date.now(),
      conversationId: get().activeConversationId ?? "",
      threadKind: "annotation" as any,
    }
    // 注：threadKind 用 cast，避免立即加到 DisplayMessage；见 Task 1.3 正式加字段
    set({
      messages: get().messages.map(m => {
        if (!m.annotations?.some(a => a.id === annotationId)) return m
        return {
          ...m,
          annotations: m.annotations.map(a =>
            a.id === annotationId
              ? { ...a, thread: [...a.thread, newMsg] }
              : a
          ),
        }
      }),
    })
  },

  resolveAnnotation: (annotationId) => {
    set({
      messages: get().messages.map(m => {
        if (!m.annotations?.some(a => a.id === annotationId)) return m
        return {
          ...m,
          annotations: m.annotations.map(a =>
            a.id === annotationId && a.status === "open"
              ? { ...a, status: "resolved" }
              : a
          ),
        }
      }),
    })
  },

  flattenAnnotation: (annotationId) => {
    const messages = get().messages
    const parent = messages.find(m => m.annotations?.some(a => a.id === annotationId))
    if (!parent) throw new Error(`annotation not found: ${annotationId}`)
    const ann = parent.annotations!.find(a => a.id === annotationId)!
    if (ann.status === "flattened") return ann.flattenedMessageIds ?? []

    const baseTs = Date.now()
    const newIds: string[] = ann.thread.map((t, i) => {
      const id = `msg_flat_${baseTs}_${i}_${Math.random().toString(36).slice(2, 6)}`
      return id
    })
    const newMainMessages: DisplayMessage[] = ann.thread.map((t, i) => ({
      ...t,
      id: newIds[i],
      conversationId: parent.conversationId,
      flattenedFromAnnotation: annotationId,
    }))

    set({
      messages: [
        ...messages,
        ...newMainMessages,
      ].map(m =>
        m.id === parent.id
          ? {
              ...m,
              annotations: m.annotations!.map(a =>
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
```

并在 `DisplayMessage` interface 里加两个字段（task 1.4 之前先临时用 `as any` cast 兜底也行，但**推荐在这里直接加**）：

```typescript
// src/stores/chat-store.ts:40-54
export interface DisplayMessage {
  // ... 现有字段 ...
  annotations?: ChatAnnotation[]
  /** 仅 annotation.thread 内 message 有此标记；用于 chatMessagesToLLM 过滤 */
  threadKind?: "annotation"
  /** 仅 flatten 后写入主 conversation 的 message 有此标记 */
  flattenedFromAnnotation?: string
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npx vitest run --environment node src/stores/chat-store.test.ts -t "annotation"`
Expected: 5 个测试 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/stores/chat-store.ts src/stores/chat-store.test.ts
git commit -m "feat(chat-store): annotation CRUD + state machine"
```

### Task 1.3: chatMessagesToLLM 过滤 annotation thread

**Files:**
- Modify: `src/stores/chat-messages-to-llm.ts`（或 chat-store 内的同名导出）
- Modify: `src/stores/chat-messages-to-llm.test.ts`

**Interfaces:**
- 修改 `chatMessagesToLLM(messages: DisplayMessage[])`：返回的 messages 必须只包含 `conversationId === target && threadKind !== "annotation"`。

- [ ] **Step 1: 写 failing test**

在 `chat-messages-to-llm.test.ts` 追加：

```typescript
import { chatMessagesToLLM, type DisplayMessage } from "./chat-store"

describe("chatMessagesToLLM filters annotation thread", () => {
  it("excludes messages marked as annotation thread", () => {
    const main: DisplayMessage = {
      id: "m1", role: "user", content: "main Q", timestamp: 1,
      conversationId: "c1",
    }
    const annThreadMsg: DisplayMessage = {
      id: "a1", role: "user", content: "follow-up",
      timestamp: 2, conversationId: "c1", threadKind: "annotation",
    }
    const out = chatMessagesToLLM([main, annThreadMsg], "c1")
    expect(out.map(m => m.id)).toEqual(["m1"])
  })

  it("includes flattened messages from annotation", () => {
    const main: DisplayMessage = {
      id: "m1", role: "user", content: "main", timestamp: 1, conversationId: "c1",
    }
    const flattened: DisplayMessage = {
      id: "f1", role: "user", content: "from annotation",
      timestamp: 2, conversationId: "c1",
      flattenedFromAnnotation: "ann_1",
    }
    const out = chatMessagesToLLM([main, flattened], "c1")
    expect(out.map(m => m.id)).toEqual(["m1", "f1"])
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run --environment node src/stores/chat-messages-to-llm.test.ts -t "filters annotation"`
Expected: FAIL（annotation 消息未被过滤）。

- [ ] **Step 3: 在 chatMessagesToLLM 里加过滤**

```typescript
// src/stores/chat-messages-to-llm.ts（找到过滤 conversationId 的位置，紧接其后）

  .filter(m => m.threadKind !== "annotation")
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run --environment node src/stores/chat-messages-to-llm.test.ts -t "annotation"`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/stores/chat-messages-to-llm.ts src/stores/chat-messages-to-llm.test.ts
git commit -m "feat(chat-store): chatMessagesToLLM excludes annotation thread"
```

### Task 1.4: persist round-trip

**Files:**
- Modify: `src/lib/persist.ts`（schema 序列化、反序列化处）
- Modify: `src/lib/auto-save.ts`（保存触发处无需改逻辑，只确认字段被透传）

**Interfaces:**
- `DisplayMessage` 的 `annotations`、`threadKind`、`flattenedFromAnnotation` 三个新字段在 persist round-trip 后保持值不变。

- [ ] **Step 1: 写 failing test**

`src/lib/persist.test.ts`（如不存在则新建）追加：

```typescript
import { serializeConversation, deserializeConversation } from "./persist"

describe("persist annotation fields", () => {
  it("round-trips annotations array", () => {
    const conv = {
      id: "c1", title: "test", createdAt: 1, updatedAt: 2,
      messages: [{
        id: "m1", role: "assistant", content: "Body", timestamp: 1,
        conversationId: "c1",
        annotations: [{
          id: "ann_1", parentMessageId: "m1", snippet: "x",
          range: { start: 0, end: 1 },
          status: "open", createdAt: 2, thread: [],
        }],
      }],
    }
    const serialized = JSON.stringify(serializeConversation(conv))
    const restored = deserializeConversation(JSON.parse(serialized))
    expect(restored.messages[0].annotations).toEqual(conv.messages[0].annotations)
  })

  it("legacy conversation without annotations loads without error", () => {
    const legacy = {
      id: "c1", title: "old", createdAt: 1, updatedAt: 2,
      messages: [{ id: "m1", role: "user", content: "x", timestamp: 1, conversationId: "c1" }],
    }
    const restored = deserializeConversation(legacy)
    expect(restored.messages[0].annotations).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run --environment node src/lib/persist.test.ts -t "annotation"`
Expected: FAIL（如果 persist 没识别字段会抛错或丢失数据）。

- [ ] **Step 3: 在 serializeConversation / deserializeConversation 透传字段**

查找 `serializeConversation` / `deserializeConversation`，确认它们用整体对象 spread（已经覆盖了 optional 字段）。如果用了 pick/whitelist 选择字段，把 `annotations`、`threadKind`、`flattenedFromAnnotation` 加进去。

典型最小改动：

```typescript
// src/lib/persist.ts:serializeConversation（如果当前实现是 spread 整体则不用改；
// 若是 pick 则追加）

const MESSAGE_PERSIST_FIELDS = [
  "id", "role", "content", "timestamp", "conversationId",
  "references", "agentSteps", "agentFileChanges", "userInputRequest",
  "images", "contextFiles", "pendingWikiWrite", "shellCommandApproval",
  // 新增：
  "annotations", "threadKind", "flattenedFromAnnotation",
] as const
```

`deserializeConversation` 不需要改（已使用宽松的 Partial 接收）。

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run --environment node src/lib/persist.test.ts`
Expected: PASS（包括老的测试）。

- [ ] **Step 5: 跑全量 mock 测试，确认 Phase 1 整体未破坏**

Run: `npx vitest run --environment node src/stores src/lib 2>&1 | tail -20`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/lib/persist.ts src/lib/persist.test.ts
git commit -m "feat(persist): round-trip ChatAnnotation + annotation markers"
```

**Phase 1 完成门**：
```bash
npm run typecheck
npx vitest run --environment node src/stores src/lib
git log --oneline main..HEAD
# 期望看到 4 个新 commit
```

---

## Phase 2：触发器 + 内联视图

### Task 2.1: selection-utils

**Files:**
- Create: `src/components/chat/annotation/selection-utils.ts`
- Create: `src/components/chat/annotation/selection-utils.test.ts`

**Interfaces:**
- Produces:
  - `getSelectionWithin(root: HTMLElement): { snippet: string; range: { start: number; end: number } } | null`
  - `isCollapsedOrEmpty(sel: Selection): boolean`

- [ ] **Step 1: 写 failing tests**

```typescript
// src/components/chat/annotation/selection-utils.test.ts
import { getSelectionWithin, getCharacterRange } from "./selection-utils"

describe("getSelectionWithin", () => {
  it("returns null when no selection", () => {
    document.body.innerHTML = '<div id="r">Hello world</div>'
    const root = document.getElementById("r")!
    window.getSelection()?.removeAllRanges()
    expect(getSelectionWithin(root)).toBeNull()
  })

  it("returns snippet and range when selection inside root", () => {
    document.body.innerHTML = '<div id="r">Hello world</div>'
    const root = document.getElementById("r")!
    const range = document.createRange()
    range.setStart(root.firstChild!, 6)
    range.setEnd(root.firstChild!, 11)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    const result = getSelectionWithin(root)
    expect(result?.snippet).toBe("world")
    expect(result?.range).toEqual({ start: 6, end: 11 })
  })

  it("returns null when selection starts outside root", () => {
    document.body.innerHTML = '<span id="a">aaa</span><div id="r">bbb</div>'
    const a = document.getElementById("a")!
    const r = document.getElementById("r")!
    const range = document.createRange()
    range.setStart(a.firstChild!, 0)
    range.setEnd(r.firstChild!, 1)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(getSelectionWithin(r)).toBeNull()
  })

  it("handles UTF-16 surrogate pair (emoji) correctly", () => {
    document.body.innerHTML = '<div id="r">A😀B</div>'
    const root = document.getElementById("r")!
    const text = root.firstChild!
    const range = document.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 3) // 😀 is 2 UTF-16 code units
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    const result = getSelectionWithin(root)
    expect(result?.snippet).toBe("😀")
    expect(result?.range).toEqual({ start: 1, end: 3 })
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run --environment node src/components/chat/annotation/selection-utils.test.ts`
Expected: 全部 FAIL（模块不存在）。

- [ ] **Step 3: 实现 selection-utils**

```typescript
// src/components/chat/annotation/selection-utils.ts

export interface SelectionWithin {
  snippet: string
  range: { start: number; end: number }
}

/**
 * 取当前 window selection；若不在 root 内、或为空/折叠、或跨越 root 边界则返回 null。
 *
 * range 是基于 root.textContent 的 UTF-16 code unit 偏移（与 String.prototype.slice 一致）。
 */
export function getSelectionWithin(root: HTMLElement): SelectionWithin | null {
  const sel = typeof window !== "undefined" ? window.getSelection() : null
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null

  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null
  }
  if (range.collapsed) return null

  const snippet = sel.toString().trim()
  if (!snippet) return null

  const charRange = getCharacterRange(root, range)
  return { snippet, range: charRange }
}

/**
 * 把 DOM Range 转为 root.textContent 内的字符偏移。
 * 使用 Range.toString() 累计偏移，对 surrogate pair 安全（toString 返回 UTF-16 长度）。
 */
export function getCharacterRange(
  root: HTMLElement,
  range: Range,
): { start: number; end: number } {
  const preRange = document.createRange()
  preRange.selectNodeContents(root)
  preRange.setEnd(range.startContainer, range.startOffset)
  const start = preRange.toString().length

  const fullRange = document.createRange()
  fullRange.selectNodeContents(root)
  fullRange.setEnd(range.endContainer, range.endOffset)
  const end = fullRange.toString().length

  return { start, end }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run --environment node src/components/chat/annotation/selection-utils.test.ts`
Expected: 4 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/components/chat/annotation/selection-utils.ts src/components/chat/annotation/selection-utils.test.ts
git commit -m "feat(annotation): selection range utilities with UTF-16 safety"
```

### Task 2.2: ChatAnnotationTrigger (右键菜单)

**Files:**
- Create: `src/components/chat/annotation/ChatAnnotationTrigger.tsx`
- Create: `src/components/chat/annotation/ChatAnnotationTrigger.test.tsx`

**Interfaces:**
- Produces `<ChatAnnotationTrigger message={msg}>{children}</ChatAnnotationTrigger>`：
  - 监听 children 容器上的 `contextmenu`
  - 选区在 message 内时弹出菜单 `💬 针对这段单独追问`
  - 点击菜单项调用 `useAnnotationActions().createAnnotation({ snippet, range, parentMessageId })`
  - 该 snippet 已有 annotation 时菜单项改为 `💬 打开已有 annotation`

- [ ] **Step 1: 安装 Radix ContextMenu（如果尚未安装）**

```bash
# 检查是否已装
grep -q "@radix-ui/react-context-menu" package.json && echo "已装" || npm install --save-dev @radix-ui/react-context-menu
```

如果已有等价方案（项目里搜 "ContextMenu"），优先复用而不是新装。

- [ ] **Step 2: 写 failing component test**

```typescript
// src/components/chat/annotation/ChatAnnotationTrigger.test.tsx
import { render, fireEvent } from "@testing-library/react"
import { ChatAnnotationTrigger } from "./ChatAnnotationTrigger"

const mockCreate = vi.fn()
vi.mock("./useAnnotationActions", () => ({
  useAnnotationActions: () => ({ createAnnotation: mockCreate }),
}))

const message = {
  id: "m1", role: "assistant", content: "Long answer with A1, A2.", conversationId: "c1", timestamp: 1,
}

describe("ChatAnnotationTrigger", () => {
  it("does not open menu on right-click with empty selection", () => {
    mockCreate.mockClear()
    const { getByTestId } = render(
      <ChatAnnotationTrigger message={message}>
        <div data-testid="content">{message.content}</div>
      </ChatAnnotationTrigger>
    )
    fireEvent.contextMenu(getByTestId("content"))
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: 跑测试，确认通过或失败**

Run: `npx vitest run --environment jsdom src/components/chat/annotation/ChatAnnotationTrigger.test.tsx`
Expected: 测试通过（当前实现是 no-op，因为还没写）。

实际上要让测试有意义，按以下顺序：**写 stub → 跑通过 → 写真实实现 → 跑仍然通过 → 提交**。

- [ ] **Step 4: 写 stub 组件**

```typescript
// src/components/chat/annotation/ChatAnnotationTrigger.tsx
import { useEffect } from "react"
import * as ContextMenu from "@radix-ui/react-context-menu"
import { getSelectionWithin } from "./selection-utils"
import { useAnnotationActions } from "./useAnnotationActions"
import type { DisplayMessage } from "../../../stores/chat-store"

export function ChatAnnotationTrigger({
  message, children,
}: { message: DisplayMessage; children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [menuState, setMenuState] = useState<{ x: number; y: number; snippet: string; range?: { start: number; end: number } } | null>(null)
  const { createAnnotation } = useAnnotationActions()

  const handleContextMenu = (e: MouseEvent) => {
    if (!containerRef.current) return
    const sel = getSelectionWithin(containerRef.current)
    if (!sel) return
    e.preventDefault()
    setMenuState({ x: e.clientX, y: e.clientY, snippet: sel.snippet, range: sel.range })
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

  return (
    <ContextMenu.Root open={!!menuState} onOpenChange={(o) => !o && setMenuState(null)}>
      <ContextMenu.Trigger asChild>
        <div ref={containerRef} onContextMenu={handleContextMenu}>
          {children}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content style={{ position: "fixed", left: menuState?.x, top: menuState?.y }}>
          <ContextMenu.Item onSelect={handleCreate}>
            💬 针对这段单独追问
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
```

（实际实现时需要 `useRef`、`useState` import，并在 selection 为空时让 ContextMenu.Root 不 open）

- [ ] **Step 5: 跑测试 + 跑 typecheck**

Run: `npm run typecheck && npx vitest run --environment jsdom src/components/chat/annotation/ChatAnnotationTrigger.test.tsx`
Expected: PASS, 0 type errors。

- [ ] **Step 6: 提交**

```bash
git add src/components/chat/annotation/ChatAnnotationTrigger.tsx src/components/chat/annotation/ChatAnnotationTrigger.test.tsx
git commit -m "feat(annotation): context menu trigger for snippet follow-up"
```

### Task 2.2b: 按段快速按钮（spec §3.2 entry B）

**Files:**
- Create: `src/components/chat/annotation/PerParagraphTrigger.tsx`
- Modify: `src/components/chat/chat-message.tsx`（按段落渲染时挂载 `<PerParagraphTrigger>`）

**Interfaces:**
- `<PerParagraphTrigger paragraph={text} parentMessageId={id} />` 在段落 hover 时显示 `💬` 按钮；点击调用 `createAnnotation({ snippet: paragraph, range: undefined, parentMessageId })`。

- [ ] **Step 1: 写 failing test**

```typescript
// src/components/chat/annotation/PerParagraphTrigger.test.tsx
import { render, fireEvent } from "@testing-library/react"
import { PerParagraphTrigger } from "./PerParagraphTrigger"

const mockCreate = vi.fn()
vi.mock("./useAnnotationActions", () => ({
  useAnnotationActions: () => ({ createAnnotation: mockCreate }),
}))

it("calls createAnnotation on click", () => {
  mockCreate.mockClear()
  const { getByLabelText } = render(
    <PerParagraphTrigger paragraph="A1 is..." parentMessageId="m1" />
  )
  fireEvent.click(getByLabelText("针对此段追问"))
  expect(mockCreate).toHaveBeenCalledWith({
    parentMessageId: "m1",
    snippet: "A1 is...",
    range: undefined,
  })
})

it("button is hidden until hover", () => {
  const { getByLabelText } = render(
    <PerParagraphTrigger paragraph="A1" parentMessageId="m1" />
  )
  const btn = getByLabelText("针对此段追问")
  expect(btn).toHaveClass("opacity-0")
  expect(btn).toHaveClass("group-hover:opacity-100")
})
```

- [ ] **Step 2: 实现**

```tsx
// src/components/chat/annotation/PerParagraphTrigger.tsx
import { useAnnotationActions } from "./useAnnotationActions"

export function PerParagraphTrigger({
  paragraph, parentMessageId,
}: { paragraph: string; parentMessageId: string }) {
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
```

- [ ] **Step 3: 在 chat-message.tsx 按段落渲染**

```tsx
// src/components/chat/chat-message.tsx（找到 markdown 渲染块）
// 把 content 按 \n\n 切段：
const paragraphs = msg.content.split(/\n\n+/)

return (
  <div data-message-id={msg.id}>
    {paragraphs.map((p, i) => (
      <div key={i} className="group relative">
        <MarkdownBlock content={p} />
        <div className="absolute right-0 top-0">
          <PerParagraphTrigger paragraph={p} parentMessageId={msg.id} />
        </div>
      </div>
    ))}
  </div>
)
```

- [ ] **Step 4: 跑测试 + typecheck**

Run: `npm run typecheck && npx vitest run --environment jsdom src/components/chat/annotation/PerParagraphTrigger.test.tsx`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/components/chat/annotation/PerParagraphTrigger.tsx src/components/chat/annotation/PerParagraphTrigger.test.tsx src/components/chat/chat-message.tsx
git commit -m "feat(annotation): per-paragraph hover button trigger"
```

### Task 2.3: useAnnotationActions hook

**Files:**
- Create: `src/components/chat/annotation/useAnnotationActions.ts`

**Interfaces:**
- Produces `useAnnotationActions()` 返回 `{ createAnnotation, appendAnnotationMessage, resolveAnnotation, flattenAnnotation }`，内部封装 chat-store action + auto-resolve timer 启动。

- [ ] **Step 1: 写实现**

```typescript
// src/components/chat/annotation/useAnnotationActions.ts
import { useCallback, useEffect } from "react"
import { useChatStore } from "../../../stores/chat-store"

const AUTO_RESOLVE_MS = 5 * 60 * 1000

export function useAnnotationActions() {
  const createAnnotation = useChatStore(s => s.createAnnotation)
  const appendAnnotationMessage = useChatStore(s => s.appendAnnotationMessage)
  const resolveAnnotation = useChatStore(s => s.resolveAnnotation)
  const flattenAnnotation = useChatStore(s => s.flattenAnnotation)

  return {
    createAnnotation: useCallback((args: { parentMessageId: string; snippet: string; range?: { start: number; end: number } }) =>
      createAnnotation(args.parentMessageId, args.snippet, args.range),
      [createAnnotation]),
    appendAnnotationMessage,
    resolveAnnotation,
    flattenAnnotation,
  }
}

/**
 * 挂在 ChatSessionContent 内；每 30s 扫描所有 annotation，
 * 对 status==='open' 且 createdAt > AUTO_RESOLVE_MS 之前的，自动 resolve。
 */
export function useAutoResolveAnnotations() {
  useEffect(() => {
    const tick = () => {
      const messages = useChatStore.getState().messages
      const now = Date.now()
      const toResolve: string[] = []
      for (const m of messages) {
        for (const a of m.annotations ?? []) {
          if (a.status === "open" && now - a.createdAt > AUTO_RESOLVE_MS) {
            toResolve.push(a.id)
          }
        }
      }
      toResolve.forEach(id => useChatStore.getState().resolveAnnotation(id))
    }
    const i = setInterval(tick, 30_000)
    return () => clearInterval(i)
  }, [])
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add src/components/chat/annotation/useAnnotationActions.ts
git commit -m "feat(annotation): actions hook + auto-resolve timer"
```

### Task 2.4: ChatAnnotationInline (折叠视图)

**Files:**
- Create: `src/components/chat/annotation/ChatAnnotationInline.tsx`
- Create: `src/components/chat/annotation/ChatAnnotationInline.test.tsx`
- Modify: `src/components/chat/chat-message.tsx`（加 `annotations` 渲染挂载点）

**Interfaces:**
- Produces `<ChatAnnotationInline annotation={ann}>`：折叠/展开切换；展开后展示 thread Q&A + 三个动作按钮（在抽屉中打开 / 插入主会话 / ✓ 明白了）。

- [ ] **Step 1: 写 failing test**

```typescript
// src/components/chat/annotation/ChatAnnotationInline.test.tsx
import { render, fireEvent } from "@testing-library/react"
import { ChatAnnotationInline } from "./ChatAnnotationInline"

const annotation = {
  id: "ann_1", parentMessageId: "m1", snippet: "A1",
  status: "open" as const, createdAt: 1,
  thread: [
    { id: "t1", role: "user" as const, content: "Q?", conversationId: "c1", timestamp: 2 },
    { id: "t2", role: "assistant" as const, content: "A.", conversationId: "c1", timestamp: 3 },
  ],
}

describe("ChatAnnotationInline", () => {
  it("renders collapsed by default", () => {
    const { getByText } = render(<ChatAnnotationInline annotation={annotation} />)
    expect(getByText(/A1/)).toBeInTheDocument()
    expect(getByText(/Q\?/)).not.toBeVisible() // thread 隐藏
  })

  it("expands on click", () => {
    const { getByRole, getByText } = render(<ChatAnnotationInline annotation={annotation} />)
    fireEvent.click(getByRole("button", { name: /展开/ }))
    expect(getByText(/Q\?/)).toBeVisible()
    expect(getByText(/A\./)).toBeVisible()
  })
})
```

- [ ] **Step 2: 实现**

```typescript
// src/components/chat/annotation/ChatAnnotationInline.tsx
import { useState } from "react"
import type { ChatAnnotation } from "../../../lib/chat-agent-types"
import { useAnnotationActions } from "./useAnnotationActions"

export function ChatAnnotationInline({ annotation }: { annotation: ChatAnnotation }) {
  const [open, setOpen] = useState(false)
  const { resolveAnnotation, flattenAnnotation } = useAnnotationActions()

  return (
    <div className="border-l-2 border-blue-300 pl-2 my-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="text-xs text-blue-600 hover:underline"
      >
        💬 {annotation.snippet.slice(0, 30)}
        {annotation.snippet.length > 30 ? "…" : ""}
        {" · "}{annotation.status === "open" ? "追问中" : annotation.status === "resolved" ? "已解决" : "已压平"}
        {" · "}{open ? "收起" : "展开"}
      </button>
      {open && (
        <div className="mt-2 text-sm space-y-1">
          {annotation.thread.map(m => (
            <div key={m.id}>
              <strong>{m.role === "user" ? "Q" : "A"}:</strong> {m.content}
            </div>
          ))}
          <div className="flex gap-2 mt-1">
            <button onClick={() => resolveAnnotation(annotation.id)} disabled={annotation.status !== "open"}>
              ✓ 明白了
            </button>
            <button onClick={() => flattenAnnotation(annotation.id)} disabled={annotation.status === "flattened"}>
              插入主会话
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 在 chat-message.tsx 挂载**

找到 `chat-message.tsx` 中 markdown 渲染后的位置，追加：

```tsx
{msg.annotations?.map(a => (
  <ChatAnnotationInline key={a.id} annotation={a} />
))}
```

并在文件顶部 import。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `npm run typecheck && npx vitest run --environment jsdom src/components/chat/annotation/`
Expected: PASS, 0 errors。

- [ ] **Step 5: 提交**

```bash
git add src/components/chat/annotation/ChatAnnotationInline.tsx src/components/chat/annotation/ChatAnnotationInline.test.tsx src/components/chat/chat-message.tsx
git commit -m "feat(annotation): inline collapsible view + mount in chat-message"
```

**Phase 2 完成门**：
```bash
npm run typecheck
npx vitest run --environment node src/components/chat/annotation src/stores src/lib 2>&1 | tail -5
git log --oneline main..HEAD
# 期望看到 ~7 个新 commit
```

---

## Phase 3：Rust 后端契约

### Task 3.1: AnnotationContext 类型（Rust）

**Files:**
- Modify: `src-tauri/src/agent/types.rs`

**Interfaces:**
- Produces `pub enum AnnotationStatus { Open, Resolved, Flattened }`（serde camelCase）
- Produces `pub struct AnnotationContext { annotation_id, parent_message_id, parent_message_content, snippet, thread: Vec<DisplayMessage>, status }`

- [ ] **Step 1: 写 failing test**

`src-tauri/src/agent/types.rs` 末尾追加（模块自带的 `#[cfg(test)]` 区）：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotation_status_serializes_camelcase() {
        let s = serde_json::to_string(&AnnotationStatus::Open).unwrap();
        assert_eq!(s, "\"open\"");
        let r: AnnotationStatus = serde_json::from_str("\"resolved\"").unwrap();
        assert_eq!(r, AnnotationStatus::Resolved);
        let f: AnnotationStatus = serde_json::from_str("\"flattened\"").unwrap();
        assert_eq!(f, AnnotationStatus::Flattened);
    }

    #[test]
    fn annotation_context_round_trips() {
        let ctx = AnnotationContext {
            annotation_id: "ann_1".into(),
            parent_message_id: "msg_1".into(),
            parent_message_content: "Body".into(),
            snippet: "snippet".into(),
            thread: vec![],
            status: AnnotationStatus::Open,
        };
        let json = serde_json::to_string(&ctx).unwrap();
        let restored: AnnotationContext = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.annotation_id, "ann_1");
        assert_eq!(restored.snippet, "snippet");
    }
}
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib agent::types::tests::`
Expected: FAIL（类型未定义）。

- [ ] **Step 3: 实现**

```rust
// src-tauri/src/agent/types.rs（追加到现有类型区）

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationStatus {
    Open,
    Resolved,
    Flattened,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationContext {
    pub annotation_id: String,
    pub parent_message_id: String,
    pub parent_message_content: String,
    pub snippet: String,
    pub thread: Vec<DisplayMessage>,
    pub status: AnnotationStatus,
}
```

（`DisplayMessage` 应已存在于 `types.rs` 或被 re-export；若不在，从 `crate::commands::chat_types::DisplayMessage` import。）

- [ ] **Step 4: 跑测试，确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib agent::types::tests::`
Expected: 2 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/agent/types.rs
git commit -m "feat(agent-types): AnnotationStatus + AnnotationContext (serde)"
```

### Task 3.2: runtime.rs 接受 annotation 字段

**Files:**
- Modify: `src-tauri/src/agent/runtime.rs`（AgentRunRequest 加 annotation 字段）

**Interfaces:**
- `pub struct AgentRunRequest { ..., pub annotation: Option<AnnotationContext> }`

- [ ] **Step 1: 写 failing test**

```rust
// src-tauri/src/agent/runtime.rs（追加到 module tests）
#[cfg(test)]
mod tests_annotation_request {
    use super::*;
    use crate::agent::types::AnnotationStatus;

    #[test]
    fn agent_run_request_accepts_annotation() {
        let req = AgentRunRequest {
            conversation_id: "c1".into(),
            project_id: "p1".into(),
            user_input: "Q".into(),
            annotation: Some(AnnotationContext {
                annotation_id: "ann_1".into(),
                parent_message_id: "msg_1".into(),
                parent_message_content: "Body".into(),
                snippet: "x".into(),
                thread: vec![],
                status: AnnotationStatus::Open,
            }),
            ..Default::default()
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"annotation\""));
        assert!(json.contains("\"snippet\":\"x\""));
    }
}
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib agent::runtime::tests_annotation_request::`
Expected: FAIL（`annotation` 字段不存在）。

- [ ] **Step 3: 在 AgentRunRequest 加字段**

```rust
// src-tauri/src/agent/runtime.rs
use crate::agent::types::AnnotationContext;

pub struct AgentRunRequest {
    // ... 现有字段 ...
    pub annotation: Option<AnnotationContext>,
}

impl Default for AgentRunRequest {
    fn default() -> Self {
        Self {
            // ... 现有字段默认 ...
            annotation: None,
        }
    }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib agent::runtime::tests_annotation_request::`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/agent/runtime.rs
git commit -m "feat(agent-runtime): accept optional AnnotationContext in run request"
```

### Task 3.3: context.rs 注入 annotation 引导块

**Files:**
- Modify: `src-tauri/src/agent/context.rs`（追加 `build_annotation_block` 函数 + 修改 `build_user_context` 让 annotation 模式下查询文本前注入父 message 全文与 snippet）

**Interfaces:**
- 新增 `pub fn build_annotation_block(ann: &AnnotationContext) -> String`，返回完整的 "Annotation Follow-up" 引导块字符串（作为 system prompt 的额外段落）。
- 修改 `build_user_context`（或新增 annotation 分支），让 annotation 模式下 user prompt 第一行就是 "User's follow-up question"，前面带 `### Original parent message` 和 `### Highlighted snippet` 标记。
- 不修改 `build_agent_context` 主流程签名；annotation 模式由 `AgentRunRequest.annotation.is_some()` 在调用入口（如 runtime.rs）判断后选择增强版组装。

- [ ] **Step 1: 写 failing test**

```rust
// src-tauri/src/agent/context.rs（追加到 module tests）
#[cfg(test)]
mod tests_annotation {
    use super::*;
    use crate::agent::types::{AnnotationContext, AnnotationStatus};

    #[test]
    fn build_annotation_block_includes_parent_snippet_and_thread_marker() {
        let ann = AnnotationContext {
            annotation_id: "ann_1".into(),
            parent_message_id: "msg_1".into(),
            parent_message_content: "Parent body content".into(),
            snippet: "highlighted".into(),
            thread: vec![],
            status: AnnotationStatus::Open,
        };
        let block = build_annotation_block(&ann);
        assert!(block.contains("Annotation Follow-up"));
        assert!(block.contains("Parent body content"));
        assert!(block.contains("> highlighted"));
        assert!(block.contains("Annotation thread so far"));
    }

    #[test]
    fn build_user_context_includes_snippet_when_annotation_present() {
        // 测 build_user_context（或新函数 build_annotation_user_context）
        // 在 annotation 模式下输出包含 snippet 与父 message 摘要标记
        let ann = AnnotationContext {
            annotation_id: "ann_1".into(),
            parent_message_id: "msg_1".into(),
            parent_message_content: "Long parent".into(),
            snippet: "anchor".into(),
            thread: vec![],
            status: AnnotationStatus::Open,
        };
        let user_prompt = build_annotation_user_context("What's anchor?", &ann, &[], &[], "");
        assert!(user_prompt.contains("anchor"));
        assert!(user_prompt.contains("Long parent"));
        assert!(user_prompt.contains("What's anchor?"));
    }
}
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib agent::context::tests_annotation::`
Expected: FAIL（`build_annotation_block` / `build_annotation_user_context` 不存在）。

- [ ] **Step 3: 实现**

```rust
// src-tauri/src/agent/context.rs（追加到现有 helpers 区）

use crate::agent::types::AnnotationContext;

/// 构造 annotation follow-up 的 system prompt 附加段。
/// 拼装在主 system 之后、user prompt 之前；不可被现有 budget 逻辑裁掉
/// （在 build_agent_context 的 system 拼接阶段直接 append 到现有字符串末尾）。
pub fn build_annotation_block(ann: &AnnotationContext) -> String {
    format!(
        "## Annotation Follow-up\n\
         Anchor on the highlighted snippet first; expand to the parent\n\
         message only if the snippet's reference is unclear.\n\n\
         ### Parent message (full):\n{}\n\n\
         ### Highlighted snippet:\n> {}\n\n\
         ### Annotation thread so far ({} turns):\n{}\n\n\
         Reply in the language the user uses in their follow-up.",
        ann.parent_message_content,
        ann.snippet,
        ann.thread.len(),
        format_annotation_thread(&ann.thread),
    )
}

/// 构造 annotation 模式下的 user prompt。
/// 与主 build_user_context 的差别：snippet + 父 message 摘要作为上下文前置。
pub fn build_annotation_user_context(
    query: &str,
    ann: &AnnotationContext,
    history: &[AgentConversationMessage],
    explicit_files: &[(String, String)],
    retrieval_summary: &str,
) -> String {
    let mut out = String::new();
    out.push_str(&format!("### Highlighted snippet\n> {}\n\n", ann.snippet));
    out.push_str(&format!("### Original parent message\n{}\n\n", ann.parent_message_content));
    if !retrieval_summary.is_empty() {
        out.push_str(&format!("### Retrieval summary\n{}\n\n", retrieval_summary));
    }
    if !explicit_files.is_empty() {
        out.push_str("### Explicit context files\n");
        for (path, body) in explicit_files {
            out.push_str(&format!("--- {} ---\n{}\n\n", path, body));
        }
    }
    // 复用 history 格式（参考现有 build_user_context 实现）
    for msg in history {
        out.push_str(&format!("[{}] {}\n", if msg.role == "user" { "user" } else { "assistant" }, msg.content));
    }
    out.push_str(&format!("\n### User follow-up\n{}\n", query));
    out
}

fn format_annotation_thread(thread: &[crate::agent::types::DisplayMessage]) -> String {
    if thread.is_empty() {
        return "(no prior turns in this annotation)".into();
    }
    thread.iter().map(|m| {
        format!("- [{}] {}", if m.role == "user" { "user" } else { "assistant" }, m.content)
    }).collect::<Vec<_>>().join("\n")
}
```

然后在 runtime.rs（或调用 `build_agent_context` 的位置）加：

```rust
// src-tauri/src/agent/runtime.rs（找到 build_agent_context 调用之前）
let mut ctx_input = /* 原 input 构造 */;
if let Some(ann) = &request.annotation {
    // 1. 把 annotation block 追加到 system 段
    let mut input = ctx_input;
    let extra = crate::agent::context::build_annotation_block(ann);
    input.query = &request.user_input;
    // 让 build_system_context 的返回值追加 extra；最简单做法：在 build_agent_context 之后拼接
    let mut built = crate::agent::context::build_agent_context(input);
    built.system.push_str("\n\n");
    built.system.push_str(&extra);
    // 2. 用 annotation 版本替换 user 段
    built.user = crate::agent::context::build_annotation_user_context(
        &request.user_input,
        ann,
        input.history,
        input.explicit_files,
        input.retrieval_summary,
    );
    return built;
}
ctx_input
```

（注：上面是示意，精确对接当前 `AgentContextInput` 的字段名 `query` / `history` / `explicit_files` / `retrieval_summary`；实际实现按现有 struct 字段名调整。）

- [ ] **Step 4: 跑测试 + cargo check**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib agent::context::tests_annotation::`
Expected: PASS。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 0 errors。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/agent/context.rs src-tauri/src/agent/runtime.rs
git commit -m "feat(agent-context): inject annotation follow-up block into system+user"
```

### Task 3.4: API endpoint 接受 annotation 字段

**Files:**
- Modify: `src-tauri/src/api_server.rs`（chat messages endpoint payload struct）

**Interfaces:**
- POST `/api/v1/chat/messages` payload 加 `annotation: Option<AnnotationContext>` 字段

- [ ] **Step 1: 写 failing test**

```rust
// src-tauri/src/api_server.rs（追加到现有 module tests 区）
#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::types::AnnotationStatus;

    #[test]
    fn chat_message_payload_accepts_annotation() {
        let json = r#"{
            "conversation_id": "c1",
            "project_id": "p1",
            "content": "follow-up",
            "annotation": {
                "annotation_id": "ann_1",
                "parent_message_id": "msg_1",
                "parent_message_content": "Body",
                "snippet": "x",
                "thread": [],
                "status": "open"
            }
        }"#;
        let req: ChatMessageRequest = serde_json::from_str(json).unwrap();
        assert!(req.annotation.is_some());
        assert_eq!(req.annotation.unwrap().snippet, "x");
    }

    #[test]
    fn chat_message_payload_legacy_without_annotation() {
        let json = r#"{
            "conversation_id": "c1",
            "project_id": "p1",
            "content": "Q"
        }"#;
        let req: ChatMessageRequest = serde_json::from_str(json).unwrap();
        assert!(req.annotation.is_none());
    }
}
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib api_server::tests::`
Expected: FAIL（annotation 字段不存在）。

- [ ] **Step 3: 在 ChatMessageRequest 加字段**

```rust
// src-tauri/src/api_server.rs
use crate::agent::types::AnnotationContext;

#[derive(Debug, Deserialize)]
pub struct ChatMessageRequest {
    pub conversation_id: String,
    pub project_id: String,
    pub content: String,
    #[serde(default)]
    pub annotation: Option<AnnotationContext>,
}
```

并在 handler 里把 annotation 透传到 `AgentRunRequest.annotation`。

- [ ] **Step 4: 跑测试，确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib api_server::tests::`
Expected: 2 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/api_server.rs
git commit -m "feat(api): chat message endpoint accepts AnnotationContext"
```

**Phase 3 完成门**：
```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib agent
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## Phase 4：抽屉 + 流式路由

### Task 4.1: 流式事件加 annotation_id

**Files:**
- Modify: `src/lib/chat-agent-types.ts`（事件 type 加可选 annotation_id）
- Modify: `src-tauri/src/agent/events.rs`（Rust 端事件序列化加 annotation_id）

**Interfaces:**
- 现有 ChatAgentEvent（文本/tool_call/agent_step 等）加 `annotationId?: string` 字段

- [ ] **Step 1: 写 failing tests**

`src/lib/chat-agent-types.test.ts` 追加：

```typescript
import type { ChatAgentEvent } from "./chat-agent-types"

describe("ChatAgentEvent annotationId", () => {
  it("accepts annotationId in events", () => {
    const e: ChatAgentEvent = {
      stage: "writing",
      annotationId: "ann_1",
    }
    const json = JSON.stringify(e)
    expect(json).toContain("\"annotationId\":\"ann_1\"")
  })

  it("annotationId is optional", () => {
    const e: ChatAgentEvent = { stage: "writing" }
    const json = JSON.stringify(e)
    expect(json).not.toContain("annotationId")
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run --environment node src/lib/chat-agent-types.test.ts`
Expected: FAIL。

- [ ] **Step 3: 在 ChatAgentEvent 加 annotationId**

```typescript
// src/lib/chat-agent-types.ts（在 ChatAgentEvent interface 内追加）

  /**
   * 当事件属于某个 annotation 的 follow-up 流时携带；UI 据此路由到对应 annotation。
   * 主 conversation turn 的事件此字段为 undefined。
   */
  annotationId?: string
```

并在 Rust 端 `events.rs` 对应 enum variant 加 `annotation_id: Option<String>` + serde `#[serde(skip_serializing_if = "Option::is_none")]`。

- [ ] **Step 4: 跑测试 + cargo test**

Run: `npx vitest run --environment node src/lib/chat-agent-types.test.ts && cargo test --manifest-path src-tauri/Cargo.toml --lib agent::events::`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lib/chat-agent-types.ts src-tauri/src/agent/events.rs
git commit -m "feat(chat-events): add annotationId for event routing"
```

### Task 4.2: streamingTargets 状态

**Files:**
- Modify: `src/stores/chat-store.ts`

**Interfaces:**
- `streamingTargets: { main: boolean; annotations: Set<string> }`
- Action: `startAnnotationStream(annotationId): AbortController`
- Action: `endAnnotationStream(annotationId): void`

- [ ] **Step 1: 写 failing test**

`src/stores/chat-store.test.ts` 追加：

```typescript
describe("streamingTargets", () => {
  it("tracks parallel main + annotation streams", () => {
    const s = useChatStore.getState()
    s.startMainStream() // 现有 API
    s.startAnnotationStream("ann_1")
    s.startAnnotationStream("ann_2")
    const t = useChatStore.getState().streamingTargets
    expect(t.main).toBe(true)
    expect([...t.annotations]).toEqual(["ann_1", "ann_2"])
    s.endAnnotationStream("ann_1")
    expect([...useChatStore.getState().streamingTargets.annotations]).toEqual(["ann_2"])
    s.endMainStream()
    expect(useChatStore.getState().streamingTargets.main).toBe(false)
  })
})
```

- [ ] **Step 2: 实现**

```typescript
// src/stores/chat-store.ts

interface ChatState {
  // ...
  streamingTargets: { main: boolean; annotations: Set<string> }
  startAnnotationStream: (annotationId: string) => void
  endAnnotationStream: (annotationId: string) => void
  startMainStream: () => void
  endMainStream: () => void
}

// 默认实现
streamingTargets: { main: false, annotations: new Set() },
startAnnotationStream: (id) => set(s => ({
  streamingTargets: { ...s.streamingTargets, annotations: new Set([...s.streamingTargets.annotations, id]) }
})),
endAnnotationStream: (id) => set(s => {
  const next = new Set(s.streamingTargets.annotations); next.delete(id)
  return { streamingTargets: { ...s.streamingTargets, annotations: next } }
}),
startMainStream: () => set(s => ({ streamingTargets: { ...s.streamingTargets, main: true } })),
endMainStream: () => set(s => ({ streamingTargets: { ...s.streamingTargets, main: false } })),
```

- [ ] **Step 3: 跑测试，确认通过**

Run: `npx vitest run --environment node src/stores/chat-store.test.ts -t "streamingTargets"`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add src/stores/chat-store.ts src/stores/chat-store.test.ts
git commit -m "feat(chat-store): streamingTargets for parallel main + annotation streams"
```

### Task 4.3: ChatAnnotationDrawer + ChatAnnotationList

**Files:**
- Create: `src/components/chat/annotation/ChatAnnotationList.tsx`
- Create: `src/components/chat/annotation/ChatAnnotationDrawer.tsx`
- Modify: `src/components/chat/chat-session-content.tsx`（挂载抽屉）

**Interfaces:**
- `<ChatAnnotationDrawer message={msg} open onClose>`：右侧 360px 抽屉，列出 message 的所有 annotation，可选择当前展示哪个。

- [ ] **Step 1: 写 failing test**

```typescript
// src/components/chat/annotation/ChatAnnotationDrawer.test.tsx
import { render, fireEvent } from "@testing-library/react"
import { ChatAnnotationDrawer } from "./ChatAnnotationDrawer"

const message = {
  id: "m1", role: "assistant" as const, content: "Body", conversationId: "c1", timestamp: 1,
  annotations: [
    { id: "ann_1", parentMessageId: "m1", snippet: "A1", status: "open" as const, createdAt: 1, thread: [] },
    { id: "ann_2", parentMessageId: "m1", snippet: "A2", status: "resolved" as const, createdAt: 2, thread: [] },
  ],
}

describe("ChatAnnotationDrawer", () => {
  it("lists all annotations for the message", () => {
    const { getByText } = render(<ChatAnnotationDrawer message={message} open onClose={() => {}} />)
    expect(getByText(/A1/)).toBeInTheDocument()
    expect(getByText(/A2/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 实现**

```tsx
// src/components/chat/annotation/ChatAnnotationDrawer.tsx
import { useState } from "react"
import type { DisplayMessage } from "../../../stores/chat-store"
import { ChatAnnotationInline } from "./ChatAnnotationInline"

export function ChatAnnotationDrawer({
  message, open, onClose,
}: { message: DisplayMessage; open: boolean; onClose: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const annotations = message.annotations ?? []
  const selected = annotations.find(a => a.id === selectedId) ?? null

  if (!open) return null

  return (
    <aside className="w-[360px] border-l p-2 flex flex-col gap-2">
      <header className="flex justify-between">
        <span>Annotations ({annotations.length})</span>
        <button onClick={onClose} aria-label="关闭抽屉">×</button>
      </header>
      <ul className="space-y-1">
        {annotations.map(a => (
          <li key={a.id}>
            <button
              className={selectedId === a.id ? "font-bold" : ""}
              onClick={() => setSelectedId(a.id)}
            >
              {a.snippet.slice(0, 30)} · {a.status}
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="border-t pt-2">
          <ChatAnnotationInline annotation={selected} />
        </div>
      )}
    </aside>
  )
}
```

并在 `chat-session-content.tsx` 找到抽屉挂载点（例如 Research 抽屉附近），用 `useState(openDrawerFor: messageId | null)` 管理，渲染 `<ChatAnnotationDrawer>`。

- [ ] **Step 3: 跑测试 + typecheck**

Run: `npm run typecheck && npx vitest run --environment jsdom src/components/chat/annotation/ChatAnnotationDrawer.test.tsx`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add src/components/chat/annotation/ChatAnnotationDrawer.tsx src/components/chat/annotation/ChatAnnotationDrawer.test.tsx src/components/chat/annotation/ChatAnnotationList.tsx src/components/chat/chat-session-content.tsx
git commit -m "feat(annotation): right drawer view + list selection"
```

### Task 4.4: 流式事件路由到 annotation

**Files:**
- Modify: `src/components/chat/chat-session-content.tsx`（事件分发逻辑）

**Interfaces:**
- 收到带 `annotationId` 的事件：追加到对应 annotation 的 thread；不影响主 conversation 流。

- [ ] **Step 1: 写 failing test**

`src/components/chat/chat-session-content.test.tsx` 追加：

```typescript
it("routes events with annotationId to annotation thread", async () => {
  // 模拟 store 已有 annotation
  // 触发 handleAgentEvent({ annotationId: "ann_1", content: "..." })
  // 验证 annotation.thread 增长，main messages 不变
})
```

具体实现参考现有 handleAgentEvent 的 mock pattern。

- [ ] **Step 2: 实现路由**

```typescript
// src/components/chat/chat-session-content.tsx（在 handleAgentEvent 内）
const handleAgentEvent = (event: ChatAgentEvent) => {
  if (event.annotationId) {
    // 路由到 annotation thread
    useChatStore.getState().appendAnnotationMessage(
      event.annotationId,
      "assistant",
      event.content ?? ""
    )
    return
  }
  // 现有主 conversation 处理
}
```

- [ ] **Step 3: 跑测试**

Run: `npx vitest run --environment jsdom src/components/chat/chat-session-content.test.tsx`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add src/components/chat/chat-session-content.tsx src/components/chat/chat-session-content.test.tsx
git commit -m "feat(chat): route stream events with annotationId to annotation"
```

### Task 4.5: 取消注册按 `(conversation_id, annotation_id)` 区分

**Files:**
- Modify: `src-tauri/src/agent/cancellation.rs`（或存放 CancellationRegistry 的文件，先 `grep` 定位）

**Interfaces:**
- `CancellationRegistry::cancel_for(conversation_id, target_id: "main" | annotation_id)` —— 取消单条目标流。
- `AgentRunRequest` 持有 annotation 时，runtime 在启动时按 `format!("{conversation_id}:{annotation_id}")` 注册；主 turn 沿用 `conversation_id` 单 key 不变。

- [ ] **Step 1: 定位 CancellationRegistry**

```bash
grep -rn "CancellationRegistry\|register_cancellation\|cancel_conversation" src-tauri/src/agent/ | head -10
```

读取现有 API，记录到 plan 注释中（如果是 `HashMap<String, AbortHandle>` 类结构，加一个二级 key；如果是单 key，加 `format!` 拼装）。

- [ ] **Step 2: 写 failing test**

```rust
// 在 cancellation 模块 tests 追加
#[tokio::test]
async fn cancel_specific_annotation_does_not_affect_main_or_others() {
    let reg = CancellationRegistry::default();
    let (tx1, _rx1) = tokio::sync::oneshot::channel();
    let (tx2, _rx2) = tokio::sync::oneshot::channel();
    reg.register("c1".into(), "main".into(), tx1);
    reg.register("c1".into(), "ann_1".into(), tx2);
    reg.cancel_for("c1".into(), "ann_1".into()).await;
    // ann_1 的 oneshot 已发；main 仍存活（用 is_cancelled 之类的 query API 验证）
    // 具体验证方式按现有 API 调整
}
```

- [ ] **Step 3: 扩展 API**

```rust
// src-tauri/src/agent/cancellation.rs（基于现有结构改造）

impl CancellationRegistry {
    pub async fn cancel_for(&self, conversation_id: &str, target_id: &str) {
        // 按 (conversation_id, target_id) 删除并触发 abort
    }
}
```

并在 runtime.rs 的 AgentRuntime::run 启动处：

```rust
let cancel_key = match &request.annotation {
    Some(ann) => format!("{}:{}", request.conversation_id, ann.annotation_id),
    None => request.conversation_id.clone(),
};
registry.register_or_replace(cancel_key, abort_handle);
```

- [ ] **Step 4: 跑测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib agent::cancellation::`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/agent/cancellation.rs src-tauri/src/agent/runtime.rs
git commit -m "feat(agent-cancellation): scope abort by (conversation_id, annotation_id)"
```

**Phase 4 完成门**：
```bash
npm run typecheck
npx vitest run --environment jsdom src/components/chat/
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## Phase 5：flatten + resolve + 状态机

### Task 5.1: ChatAnnotationFlattenDialog

**Files:**
- Create: `src/components/chat/annotation/ChatAnnotationFlattenDialog.tsx`

**Interfaces:**
- 弹窗显示将要插入的消息数 + 预览前 200 字；确认后调用 `flattenAnnotation(annotationId)`。

- [ ] **Step 1: 写 failing test**

```typescript
// ChatAnnotationFlattenDialog.test.tsx
import { render, fireEvent } from "@testing-library/react"
import { ChatAnnotationFlattenDialog } from "./ChatAnnotationFlattenDialog"

const annotation = {
  id: "ann_1", parentMessageId: "m1", snippet: "x",
  status: "open" as const, createdAt: 1,
  thread: [
    { id: "t1", role: "user" as const, content: "Q?", conversationId: "c1", timestamp: 2 },
    { id: "t2", role: "assistant" as const, content: "A.", conversationId: "c1", timestamp: 3 },
  ],
}

it("calls flattenAnnotation on confirm", () => {
  const flatten = vi.fn()
  render(<ChatAnnotationFlattenDialog annotation={annotation} open onClose={() => {}} onConfirm={flatten} />)
  fireEvent.click(screen.getByRole("button", { name: /确认/ }))
  expect(flatten).toHaveBeenCalledWith("ann_1")
})
```

- [ ] **Step 2: 实现**

```tsx
// ChatAnnotationFlattenDialog.tsx
import { useChatStore } from "../../../stores/chat-store"

export function ChatAnnotationFlattenDialog({
  annotation, open, onClose,
}: { annotation: ChatAnnotation; open: boolean; onClose: () => void }) {
  const flatten = useChatStore(s => s.flattenAnnotation)
  if (!open) return null
  return (
    <dialog open className="border p-4 rounded">
      <h3>插入主会话</h3>
      <p>将把旁注里的 {annotation.thread.length} 条消息插入到主 conversation 末尾。</p>
      <details>
        <summary>预览前 200 字</summary>
        <pre>{annotation.thread.map(m => `${m.role}: ${m.content}`).join("\n").slice(0, 200)}</pre>
      </details>
      <div className="flex gap-2 mt-2">
        <button onClick={onClose}>取消</button>
        <button onClick={() => { flatten(annotation.id); onClose() }}>确认插入</button>
      </div>
    </dialog>
  )
}
```

- [ ] **Step 3: 在 Inline 视图"插入主会话"按钮接上 dialog**

修改 `ChatAnnotationInline.tsx`：把直接的 `flattenAnnotation(annotation.id)` 调用改为先 `setShowFlattenDialog(true)`，dialog 渲染在该组件内。

- [ ] **Step 4: 跑测试 + 提交**

Run: `npx vitest run --environment jsdom src/components/chat/annotation/ChatAnnotationFlattenDialog.test.tsx`

```bash
git add src/components/chat/annotation/ChatAnnotationFlattenDialog.tsx src/components/chat/annotation/ChatAnnotationFlattenDialog.test.tsx src/components/chat/annotation/ChatAnnotationInline.tsx
git commit -m "feat(annotation): flatten confirmation dialog"
```

### Task 5.2: 集成测试 flatten

**Files:**
- Modify: `src/stores/chat-store.test.ts`（已有 Task 1.2 测试，验证集成）

- [ ] **Step 1: 跑已有 flatten 测试**

Run: `npx vitest run --environment node src/stores/chat-store.test.ts -t "flatten"`
Expected: PASS（已在 Task 1.2 写）。

- [ ] **Step 2: 添加"flatten 后不能再修改"测试**

```typescript
it("flattened annotation cannot be flattened again", () => {
  const s = useChatStore.getState()
  s.createConversation()
  const convId = useChatStore.getState().activeConversationId!
  s.addMessageToConversation(convId, "assistant", "Body")
  const parentId = useChatStore.getState().messages[0].id
  const annId = s.createAnnotation(parentId, "x")
  s.appendAnnotationMessage(annId, "user", "Q")

  s.flattenAnnotation(annId)
  const sizeAfterFirst = useChatStore.getState().messages.length
  s.flattenAnnotation(annId)
  expect(useChatStore.getState().messages.length).toBe(sizeAfterFirst)
})
```

- [ ] **Step 3: 实现 + 提交**

```bash
git add src/stores/chat-store.test.ts src/stores/chat-store.ts
git commit -m "test(chat-store): flattened annotation is idempotent"
```

**Phase 5 完成门**：
```bash
npx vitest run --environment node src/stores src/components/chat/annotation
```

---

## Phase 6：保存到 Wiki

### Task 6.1: SaveAnnotationToWikiDialog

**Files:**
- Create: `src/components/chat/annotation/SaveAnnotationToWikiDialog.tsx`
- Create: `src/components/chat/annotation/SaveAnnotationToWikiDialog.test.tsx`

**Interfaces:**
- 弹窗输入 Title + 选项（附加 snippet / 附加 thread），调用现有 `chat-save-to-wiki.ts` 的 API 走 `pending_writes`。

- [ ] **Step 1: 调研现有 save-to-wiki API**

```bash
grep -n "saveToWiki\|save_to_wiki" src/lib/chat-save-to-wiki.ts | head -10
```

找到现有 `saveToWiki(...)` 函数签名（输入 messageIds 或 message 对象、目标路径等）。

- [ ] **Step 2: 写组件**

```tsx
// SaveAnnotationToWikiDialog.tsx
import { useState } from "react"
import { saveToWiki } from "../../../lib/chat-save-to-wiki"

export function SaveAnnotationToWikiDialog({
  annotation, open, onClose,
}: { annotation: ChatAnnotation; open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState(annotation.snippet.slice(0, 40))
  const [includeSnippet, setIncludeSnippet] = useState(true)
  const [includeThread, setIncludeThread] = useState(false)

  const handleSave = async () => {
    await saveToWiki({
      targetPath: `wiki/research-notes/${title}.md`,
      title,
      frontmatter: {
        source: "chat-annotation",
        annotation_id: annotation.id,
        parent_message_id: annotation.parentMessageId,
        snippet: annotation.snippet,
      },
      body: [
        includeSnippet && `> ${annotation.snippet}`,
        includeThread && annotation.thread.map(m => `**${m.role}**: ${m.content}`).join("\n"),
      ].filter(Boolean).join("\n\n"),
    })
    onClose()
  }

  if (!open) return null
  return (
    <dialog open className="border p-4 rounded w-[420px]">
      <h3>Save annotation to wiki</h3>
      <label className="block">Title <input value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label><input type="checkbox" checked={includeSnippet} onChange={e => setIncludeSnippet(e.target.checked)} /> 附加 snippet 引用</label>
      <label><input type="checkbox" checked={includeThread} onChange={e => setIncludeThread(e.target.checked)} /> 附加完整 thread</label>
      <div className="flex gap-2 mt-2">
        <button onClick={onClose}>取消</button>
        <button onClick={handleSave}>保存</button>
      </div>
    </dialog>
  )
}
```

（`saveToWiki` 实际签名按 `src/lib/chat-save-to-wiki.ts` 现有 API 调整；确保走 `pending_writes` 确认链）

- [ ] **Step 3: 测试 + typecheck + 提交**

```bash
npm run typecheck
npx vitest run --environment jsdom src/components/chat/annotation/SaveAnnotationToWikiDialog.test.tsx
git add src/components/chat/annotation/SaveAnnotationToWikiDialog.tsx src/components/chat/annotation/SaveAnnotationToWikiDialog.test.tsx
git commit -m "feat(annotation): save annotation to wiki dialog"
```

### Task 6.2: 反向链接

**Files:**
- Modify: `src/components/chat/annotation/SaveAnnotationToWikiDialog.tsx`（保存成功后回写反向链接到 annotation 本身）

- [ ] **Step 1: 在 chat-store 加 `setAnnotationWikiPage` action**

```typescript
setAnnotationWikiPage: (annotationId: string, wikiPath: string) => void
```

实现：找到对应 annotation，加 `wikiPath: string` 字段（如未在 ChatAnnotation 类型中则追加 optional 字段）。

- [ ] **Step 2: dialog 保存成功后调用**

```typescript
useChatStore.getState().setAnnotationWikiPage(annotation.id, targetPath)
```

- [ ] **Step 3: Inline 视图渲染 📄 chip**

```tsx
{annotation.wikiPath && (
  <a href={`llm-wiki://${annotation.wikiPath}`} target="_blank" rel="noreferrer">
    📄 已保存
  </a>
)}
```

- [ ] **Step 4: 测试 + 提交**

```bash
npx vitest run --environment jsdom src/components/chat/annotation/
git add src/components/chat/annotation/ src/stores/chat-store.ts src/lib/chat-agent-types.ts
git commit -m "feat(annotation): wiki save backlink chip"
```

**Phase 6 完成门**：
```bash
npm run typecheck
npx vitest run --environment jsdom src/components/chat/annotation/
npx vitest run --environment node src/stores
```

---

## Phase 7：MCP 只读 + 键盘快捷键 + i18n

### Task 7.1: MCP 只读

**Files:**
- Modify: `mcp-server/src/api-client.ts`（加 `listAnnotations` / `readAnnotation`）
- Modify: `mcp-server/src/index.ts`（注册两个 tool）

**Interfaces:**
- `chat_annotation_list({ conversation_id }): Annotation[]`
- `chat_annotation_read({ annotation_id }): Annotation`

- [ ] **Step 1: API client 方法**

```typescript
// mcp-server/src/api-client.ts（追加）
async listAnnotations(conversationId: string): Promise<Annotation[]> {
  return this.request(`/api/v1/conversations/${conversationId}/annotations`)
}
async readAnnotation(annotationId: string): Promise<Annotation> {
  return this.request(`/api/v1/annotations/${annotationId}`)
}
```

（实际后端 endpoint 由 Rust API 提供；如果后端尚未暴露，从 `chat_messages` 全量返回里筛 `annotations` 字段即可，第一版不要求独立 endpoint。）

- [ ] **Step 2: MCP tool 注册**

```typescript
// mcp-server/src/index.ts
server.tool("chat_annotation_list", "列出指定 conversation 的全部 annotation", {
  conversation_id: z.string(),
}, async ({ conversation_id }) => {
  const items = await client.listAnnotations(conversation_id)
  return { content: [{ type: "text", text: JSON.stringify(items) }] }
})

server.tool("chat_annotation_read", "读单个 annotation 的完整 thread", {
  annotation_id: z.string(),
}, async ({ annotation_id }) => {
  const item = await client.readAnnotation(annotation_id)
  return { content: [{ type: "text", text: JSON.stringify(item) }] }
})
```

- [ ] **Step 3: 跑 MCP 测试**

```bash
npm run mcp:build
npm run mcp:test
```

Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add mcp-server/src/api-client.ts mcp-server/src/index.ts
git commit -m "feat(mcp): expose chat.annotation.list / chat.annotation.read"
```

### Task 7.2: 键盘快捷键

**Files:**
- Create: `src/components/chat/annotation/useAnnotationShortcuts.ts`
- Modify: `src/components/chat/chat-session-content.tsx`

**Interfaces:**
- `useAnnotationShortcuts({ onCreate, onToggleDrawer })` 注册 `Cmd/Ctrl+K` / `Cmd/Ctrl+Shift+A` / `Esc`。

- [ ] **Step 1: 实现**

```typescript
// useAnnotationShortcuts.ts
import { useEffect } from "react"

export function useAnnotationShortcuts({
  onCreate, onToggleDrawer,
}: { onCreate: () => void; onToggleDrawer: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === "k") { e.preventDefault(); onCreate() }
      else if (mod && e.shiftKey && e.key.toLowerCase() === "a") { e.preventDefault(); onToggleDrawer() }
      else if (e.key === "Escape") { /* 折叠或关闭抽屉由消费方决定 */ }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onCreate, onToggleDrawer])
}
```

- [ ] **Step 2: 在 chat-session-content 挂载**

```typescript
useAnnotationShortcuts({
  onCreate: () => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    // 找到当前 selection 所在的 assistant message（用 closest('[data-message-id]')）
    // 调用 createAnnotation(...)
  },
  onToggleDrawer: () => setDrawerOpen(o => !o),
})
```

- [ ] **Step 3: 测试 + 提交**

```bash
npx vitest run --environment jsdom src/components/chat/annotation/useAnnotationShortcuts.test.ts
git add src/components/chat/annotation/useAnnotationShortcuts.ts src/components/chat/chat-session-content.tsx
git commit -m "feat(annotation): keyboard shortcuts (Cmd+K / Cmd+Shift+A / Esc)"
```

### Task 7.3: i18n 文案

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/zh.json`

**Interfaces:**
- 新增键至少包含：
  - `annotation.menu.contextPrompt` = "针对这段单独追问"
  - `annotation.status.open` / `resolved` / `flattened`
  - `annotation.action.resolve` = "✓ 明白了"
  - `annotation.action.flatten` = "插入主会话"
  - `annotation.action.openInDrawer` = "在抽屉中打开"
  - `annotation.saveToWiki.title` / `path` / 复选框标签
  - `annotation.shortcut.k` / `shortcut.shiftA`

- [ ] **Step 1: 在两个 json 文件追加 keys**

```json
// src/i18n/en.json（追加）
"annotation": {
  "menu": { "contextPrompt": "Ask separately about this" },
  "status": { "open": "open", "resolved": "resolved", "flattened": "flattened" },
  "action": {
    "resolve": "✓ Got it",
    "flatten": "Insert into main conversation",
    "openInDrawer": "Open in drawer"
  },
  "saveToWiki": {
    "title": "Save annotation to wiki",
    "includeSnippet": "Include snippet as quote",
    "includeThread": "Include full thread",
    "savedBacklink": "📄 Saved"
  },
  "shortcut": { "k": "Cmd/Ctrl+K", "shiftA": "Cmd/Ctrl+Shift+A" }
}
```

`zh.json` 加中文版本。

- [ ] **Step 2: 跑 i18n parity**

Run: `npx vitest run --environment node src/i18n/i18n-parity.test.ts`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add src/i18n/en.json src/i18n/zh.json
git commit -m "feat(i18n): annotation keys (en/zh parity)"
```

**Phase 7 完成门**：
```bash
npm run typecheck
npx vitest run --environment node src/i18n/i18n-parity.test.ts
npm run mcp:test
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## 最终全局验证

```bash
# 1. Typecheck
npm run typecheck
npm --prefix mcp-server run typecheck

# 2. 单元 + 集成
npx vitest run --exclude='**/*.real-llm.test.ts' --exclude='**/mcp-server/**'
cargo test --manifest-path src-tauri/Cargo.toml --lib agent api_server
npm run mcp:test

# 3. 桌面构建（可选）
npm run tauri build
```

全部通过后：
- 在 `src/lib/changelog.ts` 顶部 `CHANGELOG` 数组添加本次版本条目（CLAUDE.md 发版纪律）
- 按 CLAUDE.md "Release version rotation" 同步四处版本号：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `extension/manifest.json`

---

## Self-Review Checklist

执行者在完成每个 Task 后对照此清单：

- [ ] **TDD 顺序**：测试先写、跑确认失败、实现、跑确认通过、commit
- [ ] **CLAUDE.md 约束**：流式期间 ChatSessionContent 不卸载；右栏互斥；Tauri command 经 `run_guarded_async`；i18n 同步
- [ ] **类型一致**：`ChatAnnotation` / `AnnotationStatus` / `annotationId` / `threadKind` / `flattenedFromAnnotation` / `wikiPath` 命名在所有任务中保持一致
- [ ] **UTF-16 偏移**：所有 range 走 UTF-16 code unit；boundary 用例进 `selection-utils.test.ts`
- [ ] **不引入新 prod 依赖**：UI 库仅在 `@radix-ui/react-context-menu` 缺失时加 dev dep
- [ ] **MCP 第一版只读**：不暴露 create / followup / flatten / resolve 写操作
- [ ] **不动现有 main-path 逻辑**：annotation-followup 是新分支，不修改原 `AgentRuntime::run()` 主流程
- [ ] **persist 向后兼容**：`annotations?` / `threadKind?` / `flattenedFromAnnotation?` 都是 optional，不 bump schemaVersion
- [ ] **每 Phase 完成门**全部通过再开下一 Phase