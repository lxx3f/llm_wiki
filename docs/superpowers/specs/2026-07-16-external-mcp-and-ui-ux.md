# External MCP Client & UI search/delete changes

This document captures three closely related changes that landed between
commits `967f9f8` and `615bcbd`:

- A new **External MCP Client** layer that lets LLM Wiki connect to
  any local stdio MCP server (MiniMax Token Plan included) and expose
  the discovered tools to the Agent.
- Search view now debounces live, with stale-response filtering.
- The Wiki preview header gains an inline quick search and the Wiki
  editor adds a Delete button on the page header.

The goal of this doc is to give future contributors an at-a-glance view
of:

1. Where the External MCP code lives and how a request flows from the
   Settings page through the Agent runtime.
2. How live search, the wiki quick search, and the delete page flow
   work today.
3. Known boundaries / future work.

## 1. External MCP Client

### 1.1 Goals & non-goals

* Connect to any local stdio MCP server.
* Works for the canonical use case: `uvx minimax-coding-plan-mcp -y`
  pointed at `MINIMAX_API_KEY` / `MINIMAX_API_HOST`.
* Generic — supports any other local stdio MCP server that an advanced
  user wants to configure.
* Replaces the historical "per-search-config" UX with a per-server
  config model.

Non-goals (for v0.6.5):

* Remote transports (Streamable HTTP, SSE) — the data model leaves
  room but only stdio is implemented.
* Per-tool permission strategies beyond "server enabled → all
  discovered tools accessible to the Agent".
* Keychain / OAuth — credentials still persist alongside the rest of
  the app's settings.
* A user-facing "ask per call" approval flow — the server-level
  enable/disable is the only gate.

### 1.2 Code layout

```
src/
  components/settings/sections/external-mcp-section.tsx
  lib/external-mcp-config.ts         ← schema + normalizer + template
  lib/external-mcp-config.test.ts
  lib/project-store.ts                ← saveExternalMcpConfig / load…
  stores/wiki-store.ts                ← externalMcpConfig state
  App.tsx                             ← start-up hydration

src-tauri/
  Cargo.toml                         ← rmcp 2.2 + client + transport-child-process
  src/agent/mcp_client.rs            ← session, naming, helpers
  src/agent/runtime.rs               ← session spawn / dispatch / prompt
  src/agent/mod.rs                   ← pub mod mcp_client
  src/lib.rs / src/api_server.rs     ← runtime config loader
  tests/fixtures/mock_mcp_server.py  ← stdio fixture for tests
```

### 1.3 Request flow

```
 Settings UI (ExternalMcpSection)
   ↓ saveExternalMcpConfig
 app-state.json  (key "externalMcpConfig")
   ↓ loadExternalMcpConfig (lib.rs / api_server.rs)
 AgentRuntimeConfig.external_mcp
   ↓ AgentRuntime::run_agent_loop
 foreach enabled server:
   McpClientSession::start (stdio spawn + initialize)
   session.list_tools → stable mcp.<server>.<tool> snapshot
   ↓
 build_agent_loop_user appends the tools to the model prompt
   ↓
 execute_agent_loop_tool:
   mcp.*  → session.call_tool via session_by_tool map
   other  → BuiltinToolRegistry (unchanged)
   ↓
 require_tool_permission requires Network for the mcp.* namespace
```

### 1.4 Key types

```rust
// src-tauri/src/agent/mcp_client.rs
pub struct ExternalMcpRuntimeConfig {
    pub enabled: bool,
    pub servers: Vec<ExternalMcpRuntimeServerConfig>,
}

pub struct ExternalMcpRuntimeServerConfig {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub timeout_ms: u64,
    pub output_char_limit: usize,
}

pub struct McpToolDefinition {
    pub name: String,           // "mcp.<server_id>.<raw_tool_name>"
    pub server_name: String,
    pub description: Option<String>,
    pub input_schema: Value,
}
```

```ts
// src/lib/external-mcp-config.ts
export interface ExternalMcpServerConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  templateId?: "minimax-token-plan";
  transport: ExternalMcpStdioTransport;
  limits: {
    startupTimeoutSeconds: number;
    toolTimeoutSeconds: number;
    maxCallsPerRun: number;
    maxOutputBytes: number;
  };
}

export interface ExternalMcpStdioTransport {
  type: "stdio";
  command: string;
  args: string[];
  workingDirectory?: string;
  environment: ExternalMcpEnvironmentVariable[];
}
```

### 1.5 Conventions & safety

* Tool names are exposed to the model as `mcp.<server_id>.<raw_name>`.
  Server IDs and raw tool names are normalized (path-unsafe characters
  become `_`).
* Environment values are only delivered to the child via
  `Command::env`. They are *never* put into `args`, JSON action
  payloads, log lines, tool observation summaries, or the chat
  history.
* Session lifecycle is per Agent run (start → tool loop → close).
  Cross-run connection pooling is intentionally deferred — easier to
  reason about cancellation, secrets, and child reaping.
* Output truncation is bounded by `output_char_limit`; oversized MCP
  output is wrapped with `[external MCP output truncated]`.
* Stderr is captured with a 32 KiB cap and used only for diagnostics
  shown in `externalMcp.start` tool events, never echoed into the
  model context.

### 1.6 MiniMax Token Plan template

`createMiniMaxTokenPlanServer()` in `external-mcp-config.ts` returns:

* ID: `minimax_token_plan`
* Command: `uvx`
* Args: `["minimax-coding-plan-mcp", "-y"]`
* Environment entries (the user fills `MINIMAX_API_KEY`):
  * `MINIMAX_API_KEY` (required)
  * `MINIMAX_API_HOST` (default `https://api.minimaxi.com`)

Operators must install `uvx` first; on Windows the absolute path can be
substituted when PATH is not picked up.

### 1.7 Tests

`agent::mcp_client::tests::*` covers:

* Config defaults / required fields.
* Stable name normalization and rejected namespaces.
* Output truncation with UTF-8 safety.
* Loader normalization of persisted configuration.
* End-to-end session over a Python stdio fixture
  (`tests/fixtures/mock_mcp_server.py`) that implements
  `initialize`, `tools/list` and `tools/call`.

The runtime integration is covered by
`agent::runtime::tests::external_mcp_session_drives_built_agent_loop_tool_dispatch`.

## 2. Search debounce & per-query token

* `src/components/search/search-view.tsx` is now live-debounced.
  Default 300 ms; the timer is reset on every keystroke.
* A `searchTokenRef` is bumped on each request and compared against
  the in-flight result so a slow request never overwrites a fresher
  keystroke.
* `Enter` cancels the debounce and fires immediately (kept for power
  users).
* `Esc` and an empty input clear `results` and `hasSearched`.
* The empty state copy is now `"Type to search"` /
  `"输入即可搜索"` and is supplied via `search.liveHint` in
  `src/i18n/en.json` and `src/i18n/zh.json`.

## 3. Wiki quick search (preview header)

`src/components/layout/preview-panel.tsx` adds:

* A search input next to the file name. Debounced 300 ms with the
  same token trick as the global Search view.
* Suggestions are filtered to the top eight pages and exclude the
  currently-open preview file so the user does not see
  "switch to itself".
* `Enter` opens the top suggestion. If there's no suggestion, the
  handler jumps to the full Search view via `setActiveView("search")`.
  (The full Search view still owns its own query state — the cross-view
  query pre-fill hook is left for a follow-up.)
* `Esc` clears the field and collapses the dropdown.
* Token matching reuses `tokenizeQuery` from `src/lib/search` so the
  fallback for pure-punctuation queries mirrors the Search view.

## 4. Wiki delete button

`src/components/editor/wiki-editor.tsx` exposes a destructive Delete
button next to `Link2` and `Edit`. The handler:

1. Refuses to delete files outside `<project>/wiki/`.
2. Invokes the existing Tauri `delete_file` IPC; the TypeScript
   wrapper `deleteFile` now goes through `assertAbsoluteFsPath`
   so a project-relative path can never be smuggled through.
3. Refreshes the project file tree on success using
   `refreshProjectFileTree` (already supported by the wiki store).
4. Calls `closePreview` to leave the preview on the next page the
   user wants.

A confirmation dialog (`<div role="alertdialog">`) keeps the action
two-step. Strings live under `editor.delete.*` in en/zh.

### 4.1 Why we did *not* add an Agent tool

The task at hand said "only UI button, no Agent tool". Future work
should add an `wiki.delete_page` builtin Agent tool with the same
project-and-session-bound pending-token pattern that already exists
for `wiki.write_page`. Until that lands, an Agent driven via
`workspace.delete_file` can technically delete the same files — but
that's an internal capability, not a model-facing surface.

## 5. Where to look first

* External MCP wiring: `src-tauri/src/agent/{mcp_client, runtime}.rs`,
  `src/lib/external-mcp-config.ts`.
* Search debounce: `src/components/search/search-view.tsx`.
* Wiki quick search: `src/components/layout/preview-panel.tsx`.
* Page delete UI: `src/components/editor/wiki-editor.tsx`.
* i18n keys: `editor.delete.*`, `search.liveHint`.

## 6. Open follow-ups

* Pre-fill `SearchView` with the Wiki quick-search query.
* Persist recent wiki quick-search queries.
* Per-call MCP tool permission UI (analogous to `wiki.write_page`
  confirmation tokens).
* OS keychain integration for environment values.
* Streamable HTTP transport for remote MCP servers.
