# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

LLM Wiki 是一个 Tauri v2 桌面知识库，由三个协作层组成：

- `src/`：React 19 + TypeScript + Vite 前端，负责界面、Zustand 状态编排、摄入流程和 Tauri IPC 调用。
- `src-tauri/`：Rust 后端，负责文件与文档解析、搜索/LanceDB、文件监听、后端 Chat Agent、本地 HTTP API、浏览器剪藏服务和系统集成。
- `mcp-server/`：独立的 Node.js MCP stdio server；它是本地 HTTP API 的薄适配层，不直接扫描项目目录，也不复制搜索、图谱或 Agent 逻辑。

桌面入口为 `src-tauri/src/main.rs`，主要初始化位于 `src-tauri/src/lib.rs`。应用启动时会注册 Tauri commands，并启动剪藏服务 `127.0.0.1:19827` 和 API server `127.0.0.1:19828`。

## 环境与常用命令

前置要求：Node.js 20+、Rust 1.70+。根目录和 `mcp-server/` 各有独立的 `package-lock.json`。

```bash
# 安装前端依赖；MCP 依赖单独安装
npm install
npm --prefix mcp-server ci

# 仅运行 Vite 前端 / 运行完整 Tauri 桌面应用
npm run dev
npm run tauri dev

# TypeScript 静态检查与构建
npm run typecheck
npm --prefix mcp-server run typecheck
npm run build                 # typecheck + Vite build
npm run mcp:build             # MCP TypeScript build
npm run tauri build           # 完整桌面打包；自动运行 build:desktop
```

Vite dev server 固定使用端口 1420（`strictPort`），HMR 使用 1421。仓库当前没有 ESLint、Prettier、Biome、Clippy 或独立 format/lint 脚本；不要声称 `npm run lint` 可用。

### 测试

前端、Rust 和 MCP 测试互相独立：

```bash
# 默认前端 mock 测试（排除 *.real-llm.test.ts 和 mcp-server）
npm run test:mocks

# 真实 LLM 测试；测试文件由环境变量决定是否启用
npm run test:llm

# package.json 中的组合入口：先 mock，再 real-LLM
npm test

# MCP 测试（先编译，再运行 Node test runner）
npm run mcp:test

# Rust 测试
cargo test --manifest-path src-tauri/Cargo.toml
```

运行单个测试：

```bash
# 单个 Vitest 文件 / 单个命名用例
npx vitest run src/path/to/file.test.ts
npx vitest run src/path/to/file.test.ts -t "test name regex"

# 单个 MCP 测试文件 / 命名用例（先生成 dist）
npm run mcp:build
node --test mcp-server/dist/test/api-client.test.js
node --test --test-name-pattern="test name regex" mcp-server/dist/test/api-client.test.js

# 单个 Rust 测试；过滤值可以是模块路径或测试函数名
cargo test --manifest-path src-tauri/Cargo.toml --lib agent::cancel
cargo test --manifest-path src-tauri/Cargo.toml --lib cancellation_registry_marks_active_session
```

真实测试从 `.env.test.local` 加载环境变量且不会覆盖现有环境。常见门禁为 `RUN_LLM_TESTS=1`；API 测试还使用 `RUN_API_TESTS=1`，并可能改写 `app-state.json`，只能针对专用测试项目运行。嵌入测试另需 `EMBEDDING_ENDPOINT` 和 `EMBEDDING_MODEL`。

GitHub CI 当前只验证前端、MCP 和 Rust 能构建，不运行上述测试套件。

## 核心架构与数据流

### 项目数据模型

用户创建的每个 wiki 都是一个普通目录，而不是应用数据库：

- `purpose.md`、`schema.md` 定义知识库目标与生成规则。
- `raw/sources/` 保存不可变原始资料；不要直接改写其中的文件。
- `wiki/` 保存生成的 Markdown 页面、`index.md`、`log.md` 和 `overview.md`。页面使用 YAML frontmatter 和 `[[wikilinks]]`。
- `.llm-wiki/` 保存项目级运行状态，包括摄入队列、聊天、Review、文件同步快照、LanceDB 和项目 skills。
- `agent-workspace/` 保存 Chat Agent 生成物。

全局应用配置不在项目目录中，而在 Tauri app data 下的 `app-state.json`。API server 会直接读取其中的配置字段并短暂缓存，因此重命名全局配置键时必须同步检查 Rust API 读取逻辑。

### 摄入与文件同步

`src/lib/ingest.ts` 和 `src/lib/ingest-queue.ts` 编排串行、可持久化的摄入流程；Rust commands 承担 PDF/Office 读取、图片提取和磁盘 IO，TypeScript 负责 LLM 分析/生成及 embedding 编排。Source Watch 位于 `src-tauri/src/commands/file_sync.rs`，将 `raw/sources/` 的外部变化重新送入同一套 ingest/delete 生命周期。不要另写一套绕过队列的来源处理逻辑。

### 搜索与向量存储

统一搜索入口是 `src-tauri/src/commands/search.rs`：关键词检索、可选 LanceDB 向量结果、RRF 融合和图谱扩展在这里完成。向量实现位于 `src-tauri/src/commands/vectorstore.rs`；当前同时保留旧的 page 级表和新的 chunk 级表以兼容已有项目，修改 schema 时不要直接删除旧表兼容路径。

### 后端 Chat Agent

`src-tauri/src/agent/` 是桌面 UI、本地 HTTP API 和 MCP 共用的 Agent substrate，集中处理路由、上下文、检索工具、skills、会话、权限和取消。`AgentRuntime` 的大致流程是：

1. `router.rs` 判断查询意图。
2. `skills.rs` 加载项目级与用户级 skills。
3. `context.rs` 按字符预算组装项目、历史和引用上下文。
4. `runtime.rs` 驱动模型与 `tools.rs` 的工具循环，并把会话写入 `.llm-wiki/chats/`。

不要在 React、API handler 或 MCP server 中重新实现 Agent 核心，否则三种入口会产生行为漂移。新增 Agent 工具应在 `src-tauri/src/agent/tools.rs` 注册，并遵守该文件集中定义的读写、命令和输出上限。

### 本地 API 与 MCP

`src-tauri/src/api_server.rs` 提供项目、文件、Review、搜索、图谱、重扫和 Chat 路由，并复用 Rust 搜索与 `AgentRuntime`。它还承担 token 校验、路径 allow-list、`safe_join`、CORS 和并发限制。新增 endpoint 时必须沿用这些边界；不要直接拼接用户传入路径。

`mcp-server/src/api-client.ts` 和 `mcp-server/src/index.ts` 只映射上述 API。新增 MCP tool 时，先在 Rust API 中提供能力，再在这两个文件中增加客户端方法与 tool。API token 通过环境变量传递，不要放进命令行参数。

## 关键代码约束

- **跨平台路径**：持久化路径和 IPC payload 使用 `/`。复用 `src/lib/path-utils.ts` 的 `normalizePath`、`joinPath` 和 `isAbsolutePath`；不要用仅检查 `/` 开头的逻辑判断绝对路径，否则 Windows drive/UNC 路径会被错误二次拼接。
- **Tauri panic 边界**：新增同步/异步 Tauri command 必须分别通过 `src-tauri/src/panic_guard.rs` 的 `run_guarded` / `run_guarded_async` 包裹。`Cargo.toml` 的 release `panic = "unwind"` 是为了捕获第三方解析器 panic，不要改成 `abort`。
- **i18n**：新增或修改翻译键时同步更新 `src/i18n/locales/en.json` 与 `zh.json`。`src/i18n/i18n-parity.test.ts` 会检查键集合、非空值和复数键配对。
- **TypeScript**：前端和 MCP 均开启 strict、unused 检查和 switch fallthrough 检查；前端 `@/*` 映射到 `src/*`。
- **API/UI 一致性**：文件、搜索和 Chat 等有副作用或安全边界的业务规则优先放在 Rust，共享给 UI/API/MCP，而不是分散复制。

## 发布与平台资源

主应用版本必须在以下四处保持一致：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `extension/manifest.json`

`mcp-server/package.json` 使用独立版本号，不与主应用同步。发布前先在 `src/lib/changelog.ts` 的 `CHANGELOG` 数组顶部添加对应版本条目，再更新主应用四处版本号。

`src-tauri/pdfium/` 中的 PDFium 二进制是随仓库和应用分发的固定资源。升级时同时更新 Windows、macOS、Linux x64/ARM64 二进制及 `SHA256SUMS`；CI 有意避免在构建时从外部下载 PDFium。各平台的 Tauri 配置还显式打包 `mcp-server/dist`、其运行依赖和对应 PDFium 资源，修改 MCP 构建输出布局时要同步检查这些资源路径。
