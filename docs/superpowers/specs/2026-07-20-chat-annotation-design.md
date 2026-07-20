# Chat Annotation 设计文档

**日期**：2026-07-20
**状态**：Draft，等待用户 review
**关联分支**：N/A（待 Phase 1 开工时新开）

## 背景与动机

LLM Wiki 的 Chat Agent 在用户调研论文 / 模型时常产生长回复（典型 6–12 个段落，每个段落都包含独立概念）。当前线性 chat 流有两个矛盾：

1. 用户对 A 段某个细节追问后，新 Q&A 把原回答推出屏幕；用户需要反复滚动才能回到 A 段继续阅读。
2. 追问产生的 Q&A 与原始回答在视觉上完全等权，长时间调研后 conversation 主线被支离破碎的小问题淹没，难以回顾。

目标：让长回复场景下，用户可以**针对原 message 的某个 snippet 单独追问**，追问结果默认以**旁注（annotation）**形式永久挂在原 message 上，不打断主 conversation 流；需要时用户可以主动把旁注"压平"插入主 conversation，或保存为 wiki 知识库页面。

## 设计决策摘要

| 维度 | 决策 |
|---|---|
| 侧线程归宿 | 永久旁注（默认）/ 可插入主会话（可选） |
| Agent 上下文 | 侧问句 + 选区片段 + 父 message 全文 |
| 触发方式 | 选中文本右键 + 按段快速按钮（双入口） |
| 展示位置 | 内联折叠（默认）+ 可切换为右侧抽屉 |
| 数据模型 | 独立 `ChatAnnotation` 类型，挂载在 `DisplayMessage.annotations` |
| 工具权限 | 保留全部工具，不在 annotation 层额外加闸 |
| 状态机 | Open → Resolved → Flattened（只读历史） |
| MCP 第一版 | 只读（`annotation.list` / `annotation.read`） |

## 1. 架构总览

### 1.1 核心抽象：Annotation

在 `DisplayMessage` 上加一个可选字段 `annotations: ChatAnnotation[]`，每条 annotation 是一个**带原 message 锚点的子对话**：

```typescript
// src/lib/chat-agent-types.ts（新增）
export interface ChatAnnotation {
  id: string                              // 旁注唯一 id
  parentMessageId: string                 // 锚定到哪条 assistant/user message
  snippet: string                         // 选中的原文片段（用于高亮回显）
  range?: { start: number; end: number }  // 在父 message content 中的字符偏移
  status: "open" | "resolved" | "flattened"
  createdAt: number
  // 旁注自己的 Q&A 流（user / assistant 交替）
  thread: DisplayMessage[]
  // 创建时的上下文快照
  contextHint?: string
}
```

`DisplayMessage` 自身**不变**，只是多挂一个数组。已存在的持久化逻辑、conversation 流、引用检索全部不受影响。

### 1.2 三层职责划分

| 层 | 模块 | 改动 |
|---|---|---|
| **数据模型** | `src/lib/chat-agent-types.ts` | 新增 `ChatAnnotation` 类型 |
| **状态/持久化** | `src/stores/chat-store.ts`、`src/lib/persist.ts` | annotation CRUD；持久化序列化；`chatMessagesToLLM()` 过滤 annotation thread 不进入主上下文 |
| **UI 渲染** | `src/components/chat/annotation/{Inline,Drawer,Trigger,FlattenDialog,List,Thread,SaveToWikiDialog}.tsx` | 新增目录 |
| **Agent 调用** | `src-tauri/src/agent/types.rs`、`runtime.rs`、`context.rs`、`commands/agent_chat*.rs` | 新增 annotation-followup 调用路径，复用 `AgentRuntime` |
| **API/MCP** | `src-tauri/src/api_server.rs`、`mcp-server/src/index.ts` | API 扩 chat endpoint；MCP 第一版只读 |

### 1.3 不在本设计范围内的部分

- 多人协作 annotation
- annotation 跨 message 链接（A1 的 annotation 引用 A2 的 annotation）
- annotation 全文搜索（用现有 wiki/source 搜索）
- annotation 自动写入 wiki 章节（用户手动触发）
- annotation thread 中嵌套 annotation

## 2. Agent context 拼装与 Rust 端契约

### 2.1 契约：annotation-followup 是新的调用路径

```rust
// src-tauri/src/agent/types.rs（新增）
pub enum AnnotationStatus { Open, Resolved, Flattened }

pub struct AnnotationContext {
    pub annotation_id: String,
    pub parent_message_id: String,
    /// 父 assistant message 的完整原文（调用方显式传入，不从 conversation 取）
    pub parent_message_content: String,
    pub snippet: String,
    pub thread: Vec<DisplayMessage>,
    pub status: AnnotationStatus,
}

// src-tauri/src/agent/runtime.rs（扩展 run 入口）
pub struct AgentRunRequest {
    pub conversation_id: String,
    pub project_id: String,
    pub user_input: String,
    pub mode: ChatAgentMode,
    pub retrieval_mode: ChatRetrievalMode,
    pub annotation: Option<AnnotationContext>,  // 普通 turn 为 None
}
```

主 turn 路径**不变**；annotation 路径走同一个 `AgentRuntime::run()`，但携带 `annotation` 字段。

### 2.2 Context 拼装（`context.rs`）

```text
if let Some(ann) = request.annotation {
    inject_system_block(
      "## Annotation Follow-up\n\
       Anchor on the highlighted snippet first; expand to the parent\n\
       message only if the snippet's reference is unclear.\n\n\
       ### Parent message (full):\n{ann.parent_message_content}\n\n\
       ### Highlighted snippet:\n> {ann.snippet}\n\n\
       ### Annotation thread so far ({n} turns):\n{format_thread(&ann.thread)}\n\n\
       Reply in the language the user uses in their follow-up.",
      priority = SystemPriority::AnnotationContext
    );
    include_main_history_with_lower_budget();
} else {
    include_main_history_with_normal_budget();
}
```

约束：
- 不修改 `AgentRuntime::run()` 的主流程，只增 context 内容
- token 预算走 character budget（沿用现有 `agent/context.rs`）
- annotation 引导块优先级最高且**不可被裁剪**

### 2.3 工具与写权限

默认 annotation turn **保留全部工具能力**：
- `wiki.read_page`、`source.search`、`wiki.search` 调研时常用
- 副作用（`wiki.write`、`shell.exec`）走现有 `WikiWriteMode` + `pending_writes` 确认链，**不在 annotation 层额外加闸**

对话历史隔离：
- `chatMessagesToLLM()` 拼装主 turn 历史时**跳过** annotation thread
- annotation thread 是自包含子会话，只在 annotation-followup 时显式注入

### 2.4 流式事件

现有 SSE / event 协议加一个可选 `annotation_id` 字段：

```typescript
{ type: "text_delta", content: "...", annotation_id?: string }
{ type: "tool_call", tool: "...", annotation_id?: string }
{ type: "agent_step", step: {...}, annotation_id?: string }
```

UI 路由：
- `annotation_id == null` → 主 conversation 流
- `annotation_id == "ann_xxx"` → 渲染到对应 annotation 的抽屉/内联视图

取消：复用 `CancellationRegistry`，key = `format!("{conversation_id}:{annotation_id}")`。

### 2.5 状态机

```text
                  创建                 发送追问                 标记解决
   (不存在) ─────────────► Open ──────────────────► Resolved
                            │                          │
                            │ 用户主动"插入主会话"       │
                            ▼                          ▼
                       Flattened ◄────────────────────┘
                            │
                            ▼
                       (只读历史)
```

转换规则：
- **Open → Resolved**：用户在 annotation 顶部点击"✓ 明白了"，或 5 分钟无活动后自动
- **Open/Resolved → Flattened**：用户点击"插入主会话"，thread 内容作为新 user/assistant 消息追加到主 conversation 末尾；annotation 保留为只读（status=flattened），snippet 高亮保留
- **Flattened 之后不可再修改**

### 2.6 持久化

annotation 不需要新表——它挂在 `DisplayMessage.annotations` 里，跟着 conversation 一起序列化。Rust 端不存 annotation 状态。

`src/lib/persist.ts` 已有的 conversation 序列化需要支持 `annotations` 字段 round-trip。`DisplayMessage.annotations?: ChatAnnotation[]` 始终 optional；persist.ts 加载时缺失字段默认为 `undefined`，**不** bump schemaVersion（向后兼容）。

### 2.7 API/MCP 暴露面

Rust API（`src-tauri/src/api_server.rs`）扩展现有 chat endpoint：

```text
POST /api/v1/chat/messages
{
  "conversation_id": "...",
  "project_id": "...",
  "content": "追问内容",
  "annotation": {  // 可选
    "annotation_id": "ann_xxx",
    "parent_message_id": "msg_yyy",
    "parent_message_content": "...",
    "snippet": "...",
    "thread": [...],
    "status": "open"
  }
}
```

MCP 第一版只暴露读操作：
- `chat.annotation.list(conversation_id)`
- `chat.annotation.read(annotation_id)`

写操作（create / followup / flatten / resolve）留到第二版。

## 3. UI 组件、Selection 交互、保存到 Wiki

### 3.1 新增组件（`src/components/chat/annotation/`）

```
annotation/
├── ChatAnnotationTrigger.tsx        # 双入口触发器
├── ChatAnnotationInline.tsx         # 内联折叠视图
├── ChatAnnotationDrawer.tsx         # 右侧抽屉视图
├── ChatAnnotationFlattenDialog.tsx  # 插入主会话确认
├── ChatAnnotationThread.tsx         # 复用 chat-message.tsx 的 thread 渲染
├── ChatAnnotationList.tsx           # 抽屉里的 annotation 列表
├── SaveAnnotationToWikiDialog.tsx   # 保存为 wiki 页面
├── useAnnotationActions.ts          # action hooks
├── useAnnotationShortcuts.ts        # 键盘快捷键
└── selection-utils.ts               # window.getSelection() 封装
```

`ChatAnnotationThread.tsx` **复用** `chat-message.tsx` 渲染单条消息的逻辑（提取为可复用子组件），不重写 markdown 渲染。

### 3.2 触发入口

**入口 A：选中文本右键**

```typescript
const handleContextMenu = (e: MouseEvent) => {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return
  if (!isSelectionWithinMessage(sel, containerRef.current)) return
  e.preventDefault()
  setContextMenu({
    x: e.clientX, y: e.clientY,
    snippet: sel.toString(),
    range: getCharacterRange(containerRef.current, sel),
  })
}
```

菜单项：`💬 针对这段单独追问` / `💬 打开已有 annotation`（如果该 snippet 已有）。

**入口 B：按段快速按钮**

按 `\n\n` 切分 message content，每个段落 hover 时右侧出现 `💬` 按钮，点击以该段为 snippet 追问。

两入口最终调用 `useAnnotationActions().createAnnotation({ snippet, range, parentMessageId })`。

### 3.3 视图渲染

**内联视图（默认）**

```text
┌─ Assistant message ──────────────────────────────────┐
│ ...前文...                                              │
│                                                        │
│ > 选中的片段文字...                          [💬 已追问]│
│                                                        │
│   ▼ 折叠的 annotation header：1 个追问 · 已解决         │
│     Q: 追问内容                                         │
│     A: 回答内容                                         │
│     [在抽屉中打开]  [插入主会话]  [✓ 明白了]             │
│                                                        │
│ ...后文...                                              │
└────────────────────────────────────────────────────────┘
```

- 默认折叠，snippet 行只显示 chip
- 多 annotation 用并排 chip，不纵向挤占

**抽屉视图**

```text
┌─ 抽屉（右侧 360px 宽）──┐
│ 回到主会话                     │
│ Annotations (3)                │
│ ├─ snippet1...  open    [→]    │
│ ├─ snippet2...  resolved [→]  │
│ └─ snippet3...  flattened[→]  │
│ ── 当前选中：snippet1 ──      │
│ > 选区片段                    │
│ Q: 追问                       │
│ A: 回答（流式）               │
│ [输入框] [发送]                │
└────────────────────────────────┘
```

抽屉与现有 `WikiPageAssistant` / `ResearchStore` 的右栏**互斥**（CLAUDE.md 已有约束），通过 `rightPane` 状态机管理 active pane，新加 pane kind `'annotation-drawer'`。

### 3.4 流式状态与 ChatSessionContent 集成

annotation followup 的流式**必须遵守** CLAUDE.md 约束：流式期间不卸载 `ChatSessionContent`，继续持有 controller；`activeConversationId` / `messages` / `isStreaming` 不变，只把事件路由到 annotation 的 thread。

`chat-store.ts` 新增：

```typescript
streamingTargets: {
  main: boolean              // 主 turn 流式
  annotations: Set<string>   // 正在流式的 annotation id 集合
}
```

取消：按 `(conversation_id, target_id)` 唯一 key。

### 3.5 保存到 Wiki

`SaveAnnotationToWikiDialog`：

```text
┌─ Save annotation to wiki ──────────────┐
│  Snippet:                              │
│  > 选区片段...                          │
│  Title: [______] (默认 snippet 前 40 字)│
│  Target path:                          │
│  wiki/research-notes/{title}.md        │
│  ☐ 附加 snippet 原文（markdown 引用）   │
│  ☐ 附加完整 thread                      │
│  [取消]            [保存为 Wiki 页面]   │
└────────────────────────────────────────┘
```

走现有 `chat-save-to-wiki.ts` 链路 + `pending_writes` 确认流。frontmatter：

```yaml
---
source: chat-annotation
parent_message_id: msg_xxx
annotation_id: ann_xxx
snippet: "..."
created_at: 2026-07-20T...
---
```

反向链接：wiki 页底部加 `## 来源` 段，引用父 conversation（`llm-wiki://conversations/{conv_id}#msg_{msg_id}`）。annotation chip 显示 `📄 已保存为 Wiki`，点击在新窗口打开。

### 3.6 键盘快捷键

| 快捷键 | 行为 |
|---|---|
| `Cmd/Ctrl + K` | 当前选区存在 → 创建 annotation |
| `Cmd/Ctrl + Shift + A` | 切换当前 message 的 annotation 抽屉 |
| `Esc` | 折叠当前展开的 annotation 或关闭抽屉 |

### 3.7 复用现有模式

- 样式走现有 Tailwind 配置
- 优先用 Radix 的 `ContextMenu` / `Popover`，不引入新 UI 库
- 不动 `chat-message.tsx` 核心 markdown 渲染，只加 `onAnnotationCreate?: () => void` 和 `selectionContainerRef` 转发
- i18n：所有新文案同步 `en.json` + `zh.json`

## 4. 测试策略

### 4.1 单元测试（vitest）

| 模块 | 关键用例 |
|---|---|
| `selection-utils.ts` | 选区 → range；跨段落 / 跨 message 边界过滤；空选区；emoji 与中文 UTF-16 code unit 偏移正确性 |
| `chat-store` annotation CRUD | create / append / flatten / resolve 后结构正确；`chatMessagesToLLM()` 不返回 annotation thread |
| `useAnnotationActions` hooks | active conversation 切换清理；批量 flatten 顺序；自动 resolve timer |
| `ChatAnnotationTrigger` | 右键不冒泡；annotation 已存在时显示"打开已有"；长段落按钮可点击 |
| 持久化往返 | annotation 写入 `.json` 再加载完整恢复；老 conversation 文件兼容 |

### 4.2 集成测试

| 场景 | 验证 |
|---|---|
| annotation-followup 调用 | mock Rust 后端响应，验证 payload 包含父 message 全文 + snippet + thread |
| 流式事件路由 | mock 发 `text_delta { annotation_id }`，UI 追加到对应 annotation，主 conversation 不变；主 turn 与 annotation 并行不串流 |
| flatten 行为 | ① annotation.thread 追加到主 conversation ② status = flattened ③ snippet 高亮保留 ④ `chatMessagesToLLM()` 包含新消息 |
| 保存到 wiki | `pendingWikiWrite` 走完整确认链；frontmatter 正确；反向链接格式正确 |
| i18n parity | 新文案 en/zh 同步，触发 `i18n-parity.test.ts` 通过 |

### 4.3 Rust 单元测试

| 路径 | 测试 |
|---|---|
| `agent/context.rs` | annotation 引导块优先级与不可裁剪性；token 预算超限裁剪顺序 |
| `agent/runtime.rs` | `AgentRunRequest.annotation` None/Some 路径分支；同 conversation 主 turn + annotation 并发不冲突 |
| `agent/types.rs` | `AnnotationContext` serde round-trip；status enum 序列化大小写 |
| `api_server.rs` | chat endpoint 接受 `annotation` 字段；缺字段兼容老 client |

### 4.4 手工 smoke

```bash
npm run typecheck
npx vitest run --environment node \
  src/stores/chat-store.test.ts \
  src/components/chat/annotation
cargo test --manifest-path src-tauri/Cargo.toml --lib agent
npm run mcp:test
```

## 5. 风险点与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Rust `char` vs JS `slice` 偏移基准不一致 | 选区 range 跨语言错位 | 统一 UTF-16 code unit；boundary 显式转换；加测试 |
| 流式期间 annotation 与主 turn 并发 | AbortController 误取消、事件串流 | `streamingTargets` 显式建模；按 `(conv, target_id)` 注册 |
| 右栏互斥违反 CLAUDE.md | annotation 抽屉与 WikiPageAssistant / ResearchStore 同时打开 | 走 `rightPane` 状态机，pane kind `'annotation-drawer'` |
| 持久化 schema 演进 | 旧 conversation 文件无 `annotations` 字段 | `annotations?` 始终 optional；persist.ts 缺字段默认 `undefined`，不 bump schemaVersion |
| flatten 后主 conversation 引用错乱 | `parentMessageId` 指向老 message | flatten 时给新追加 message 打 `flattenedFromAnnotation: annotationId` 标记，不动 `parentMessageId` |
| annotation 引用过期 | 旁注里的 wiki 引用改动后失效 | annotation header 标注"父 message 创建于 X"弱提醒，不强求实时校验 |
| MCP 暴露写操作引入嵌套复杂度 | "agent-in-agent" | 第一版只读 |
| 大 annotation 数量下抽屉性能 | 1000+ 列表卡顿 | 后续用虚拟列表（`@tanstack/react-virtual`），先不上 |

## 6. 实施顺序

```
Phase 1: 数据模型 + 持久化
  ├─ chat-agent-types.ts: ChatAnnotation
  ├─ chat-store.ts: annotation CRUD + streamingTargets
  ├─ persist.ts: round-trip 序列化
  └─ chat-store.test.ts + persist 集成

Phase 2: 触发器 + 内联视图
  ├─ selection-utils.ts
  ├─ ChatAnnotationTrigger.tsx
  ├─ ChatAnnotationInline.tsx
  └─ selection-utils 单测 + 触发器组件测试

Phase 3: Agent 后端契约
  ├─ Rust: agent/types.rs AnnotationContext
  ├─ Rust: agent/context.rs annotation 引导块注入
  ├─ Rust: agent/runtime.rs 接受 annotation 字段
  ├─ Rust: api_server.rs 扩 chat endpoint
  └─ cargo test agent::* + API mock

Phase 4: 抽屉 + 流式路由
  ├─ ChatAnnotationDrawer.tsx
  ├─ ChatAnnotationList.tsx
  ├─ 右栏状态机扩展
  ├─ 流式事件加 annotation_id 路由
  └─ 流式事件路由集成

Phase 5: flatten + resolve + 状态机
  ├─ ChatAnnotationFlattenDialog.tsx
  ├─ useAnnotationActions.ts
  ├─ 自动 resolve timer
  └─ flatten 集成

Phase 6: 保存到 wiki 集成
  ├─ SaveAnnotationToWikiDialog.tsx
  ├─ 复用 pending_writes 链
  ├─ 反向链接
  └─ 保存到 wiki 集成

Phase 7: MCP 只读 + 键盘快捷键 + i18n
  ├─ mcp-server/src/index.ts: annotation.list / annotation.read
  ├─ useAnnotationShortcuts.ts
  └─ en.json / zh.json 补全 + i18n-parity 测试
```

每 Phase 后跑 `npm run typecheck` + `cargo check` + 对应 vitest 套件再合。

## 7. 估算

| Phase | 文件数 | 预估代码量（含测试） |
|---|---|---|
| 1 | 3 改 + 2 新测试 | ~300 行 |
| 2 | 4 新 | ~600 行 |
| 3 | 4 改 Rust + 1 测 | ~500 行 |
| 4 | 4 新 + 2 改 | ~700 行 |
| 5 | 3 新 | ~400 行 |
| 6 | 2 新 + 1 改 | ~400 行 |
| 7 | 3 改 + 1 测 | ~300 行 |
| **总计** | **~20 文件** | **~3200 行** |

不含 `changelog.ts` 顶部版本号条目（CLAUDE.md 主应用发版纪律，按 Phase 1 开始时一并 bump）。

## 8. 已确定的默认决策（不留到实现期）

| 问题 | 默认决策 | 备注 |
|---|---|---|
| 自动 resolve timer 放哪 | 前端 `chat-store` 用 `setTimeout`；5 min 无活动 → Resolved | 后端不存 ephemeral timer，避免分布式一致性 |
| `range` 偏移基准 | **UTF-16 code unit**（与 `String.prototype.slice` 一致） | Rust 端 boundary 处显式转换；边界用例进 `selection-utils` 单测 |
| 抽屉宽度 | 固定 360px；不可拖拽 | 与现有右栏默认宽一致；后续如需可拖拽再单独设计 |
| flatten 后主 conversation 新消息角标 | 加 `flattenedFromAnnotation?: string` 字段；UI 默认隐藏角标，用户可开 Settings → Chat → "显示来自旁注的消息角标" | 默认隐藏避免视觉噪音 |
| 多选区（Ctrl/⌘ 多段） | **不支持**；`selection-utils` 只接受单一连续 range，多段选区在右键时降级为整段第一个 range | 避免 model 上下文混乱 |
| 触屏 / 长按 | **不在第一版**；desktop-only，触屏走"按段 ? 按钮"入口 | 后续按需补 |
| 同一 snippet 多 annotation | **支持**；同一 snippet 多次右键可创建多个独立 annotation（每次生成新 id） | 用户可对同一段做不同角度追问 |