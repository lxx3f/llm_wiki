# Enhanced Shell Mode — Design

Date: 2026-07-17
Status: implemented

## Problem

The Chat Agent's `shell.exec` tool was previously gated by two independent requirements:

1. **Skill activation** — every `shell.exec` call was rejected unless at least one skill was active for the current turn.
2. **Workspace-local path scope** — commands touching paths outside `<project>/agent-workspace/` required per-call user approval.

In practice this was too restrictive for the increasingly common "introspect an installed library" workflow:

- `python -c "import inspect; print(inspect.getsource(transformers.AutoModel.forward))"` — touches `site-packages/transformers/...`, which is outside the workspace → blocked by the path-scope rule.
- The skill requirement layered on top blocked the same command because users rarely have a skill active on the first turn → the agent fell back to `web.search`, which returns generic docs instead of the user's installed source.

Result: a user query like "查一下本地的 transformers 库是否集成了 MiniMax M3" degraded to a web search with the agent explaining it couldn't read local site-packages because no skill was active.

## Goal

Make the agent behave like a coding agent (Claude Code / Cursor) by default:

- Read on-disk source via `python -c "import inspect; ..."`, `rg <symbol>`, `git log`, `cat <file>`, etc., without per-call popups.
- Keep the existing deny gates for network, privilege escalation, destructive system paths, and shell substitution.

## Design

### Two independent opt-ins

`shell.exec` is unlocked by either of:

- **Enhanced shell mode** (Settings → General, default ON) — the user's explicit opt-in for shell access.
- **An active skill** — the original opt-in path (still useful for skill-specific command-line work).

Either alone is sufficient. The earlier code hard-required the skill path even when Enhanced was on, defeating the purpose of the toggle.

### Execute-time gate — `agent/runtime.rs`

The check at the start of `shell.exec` handling in `AgentRuntime` was relaxed from

```rust
if skills.is_empty() { reject("...requires an active skill...") }
```

to

```rust
if skills.is_empty() && !self.enhanced_shell_mode { reject(...) }
```

The `agent_start_turn_stream` request already carries `enhancedShellMode` in `app-state.json`, loaded via `wiki-store`. No new IPC fields needed.

### Tool-list gate — `agent/runtime.rs`

The `build_agent_loop_user` prompt that the planner reads only listed `- shell.exec:` when `!skills.is_empty()`. With the change, the listing condition is `shell_listed = !skills.is_empty() || enhanced_shell_mode`, so a fresh turn with no skill but Enhanced on **does** tell the planner the tool exists.

The signature picked up an extra `enhanced_shell_mode: bool` parameter that the call site passes via `self.enhanced_shell_mode`.

### System prompt and tool description

The text describing `shell.exec` was rewritten to:

- Drop the "only when a selected/available skill requires command-line work" framing.
- List the Enhanced-mode safe binaries (`cat`, `head`, `grep`, `rg`, `sed`, `awk`, `find`, `jq`, `python`, `python3`, `pip`, `uv`, `uvx`, `node`, `npm`, `git`, `cargo`, `go`, …).
- Reinforce the always-deny set: `curl`, `wget`, `ssh`, `scp`, `sudo`, `doas`, `/etc/`, `/usr/`, `/var/`, `C:\Windows`, `rm -rf /`, `chmod 777`, `$(…)`, backticks.

A second tool-policy line is conditionally appended by `agent/context.rs` when the router hint for local-library introspection is set (see below).

### Router hint for "local library" intent — `agent/router.rs`

`RouterDecision` gained `should_hint_shell: bool`. The router scans the lowercased user message for phrases that indicate a local-software lookup (Chinese `本地/已安装/site-packages`, English `local library/installed package`, etc.) and sets the flag.

When the flag is true, `build_system_context` appends:

> shell.exec is available for inspecting locally installed Python libraries and packages. When the user asks about a 'local' / '本地' library, installed package, or site-packages code (e.g. "本地的transformers库是否集成了X"), prefer `shell.exec` with `python -c "import inspect; ..."` or `rg <symbol>` over `web.search`.

This nudges the planner toward local introspection even on queries that don't literally include "本地". A generic "transformers 是做什么的" query (no local signal) still routes normally and lets the planner pick `web.search`.

Two new router tests live alongside the existing pair:
- `router_hints_shell_for_local_library_queries` — covers Chinese, English, and `site-packages` phrasings.
- `router_does_not_hint_shell_for_generic_questions` — ensures over-broad matching doesn't fire on generic library questions.

### Windows: default to Git Bash — `agent/tools.rs`

`run_shell_exec` previously hard-coded `cmd.exe /C <command>` on Windows, which silently changed the meaning of `python`, `rg`, `$(...)`, `&&`, globbing, etc. Two helpers were added:

- `resolve_git_bash_program()` — probes `PATH` for `bash.exe`/`bash`, then falls back to the well-known `C:\Program Files\Git\bin\bash.exe` (and 3 sibling locations). Returns `None` if nothing is found.
- `program_path_looks_like_bash(&program)` — decides whether to dispatch with `-c` (POSIX) or `/C` (cmd.exe).

Inside the Windows `#[cfg]` arm of `run_shell_exec`:

```rust
let bash_program = resolve_git_bash_program()
    .unwrap_or_else(|| std::env::var_os("ComSpec").unwrap_or_else(|| "cmd".into()));
let using_bash = program_path_looks_like_bash(&bash_program);
Command::new(bash_program)
    .args(if using_bash { ["-c", command] } else { ["/C", command] })
    ...
```

The feature degrades cleanly on machines without Git for Windows — the existing `cmd.exe` fallback is the same one the original code used. Two unit tests live in `shell_program_tests` to lock in the helpers' behavior independent of the host machine.

## Files touched

| File | Change |
|---|---|
| `src-tauri/src/agent/runtime.rs` | Relax gate, pass `enhanced_shell_mode` to `build_agent_loop_user`, rewrite prompts and tool description, gate `shell.exec` listing on `shell_listed`. |
| `src-tauri/src/agent/router.rs` | Add `should_hint_shell` field + keyword match + 2 tests. |
| `src-tauri/src/agent/context.rs` | Append the local-library tool policy line when `router.should_hint_shell`. |
| `src-tauri/src/agent/tools.rs` | `resolve_git_bash_program`, `program_path_looks_like_bash`, dispatch in `run_shell_exec`, 2 unit tests. |
| `CLAUDE.md`, `README.md`, `README_CN.md` | Document Enhanced shell mode. |

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml --lib agent::tools::shell_program_tests` — 2 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib agent::router` — 4 passed (2 existing + 2 new).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib agent::runtime::tests` — 82 passed.

## Out of scope

- Per-tool permission prompts (kept global, matches earlier design notes).
- macOS / Linux `bash` resolution (the host shell path `/bin/sh -c` is unchanged).
- Capturing interactive `bash` features (`PROMPT_COMMAND`, aliases in user's `~/.bashrc`) — we exec a fresh non-login `bash -c` deliberately, to keep the behavior deterministic.
