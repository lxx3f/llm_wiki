use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::fs::OpenOptions;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use walkdir::WalkDir;

use crate::commands::external_search::file_url_for_path;
use crate::commands::search::{self, SearchEmbeddingConfig};

use super::types::{AgentKnowledgeContext, AgentReference, AgentVersionSummary};
use super::workspace::{agent_workspace_path, AGENT_WORKSPACE_DIR};

// Tool I/O limits are backend security boundaries. Do not relax them only in
// the UI: API and MCP callers can invoke the same tools without going through
// React components.
const MAX_READ_PAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_WRITE_PAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_WORKSPACE_WRITE_BYTES: usize = 2 * 1024 * 1024;
// Rollback snapshots are sent to the trusted desktop UI only for the current
// process lifetime. Bound them independently from write size so a large Agent
// artifact cannot multiply IPC and in-memory chat costs merely to enable Undo.
const MAX_WORKSPACE_ROLLBACK_BYTES: u64 = 512 * 1024;
const MAX_SOURCE_SEARCH_FILES: usize = 10_000;
const MAX_SOURCE_SNIPPET_CHARS: usize = 500;
const MAX_GRAPH_SEARCH_FILES: usize = 10_000;
const MAX_KNOWLEDGE_CONTEXT_ITEMS: usize = 20;
const WEB_SEARCH_TIMEOUT_SECS: u64 = 30;
const SHELL_EXEC_TIMEOUT_SECS: u64 = 30;
const MAX_SHELL_COMMAND_CHARS: usize = 4_000;
const MAX_SHELL_OUTPUT_CHARS: usize = 20_000;
const MAX_SHELL_GENERATED_FILES: usize = 50;
const SHELL_OUTPUT_DRAIN_TIMEOUT_SECS: u64 = 1;
const DEFAULT_ANYTXT_ENDPOINT: &str = "http://127.0.0.1:9920";
const DEFAULT_ANYTXT_LIMIT: usize = 20;
const ANYTXT_LAST_MODIFY_END: i64 = 2_147_483_647;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolEffect {
    Read,
    Write,
    Network,
    Process,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub effects: Vec<ToolEffect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<serde_json::Value>,
}

#[allow(dead_code)]
pub trait AgentTool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    fn execute<'a>(
        &'a self,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
}

pub trait ToolRegistry {
    #[allow(dead_code)]
    fn specs(&self) -> Vec<ToolSpec>;
    fn execute<'a>(
        &'a self,
        name: &'a str,
        input: Value,
        context: ToolContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct BuiltinToolRegistry;

#[derive(Clone)]
pub struct ToolContext<'a> {
    pub project_path: &'a str,
    pub project_id: &'a str,
    pub session_id: Option<String>,
    pub embedding_config: Option<SearchEmbeddingConfig>,
    pub web_search_config: Option<WebSearchConfig>,
    pub anytxt_config: Option<AnyTxtConfig>,
}

impl ToolRegistry for BuiltinToolRegistry {
    fn specs(&self) -> Vec<ToolSpec> {
        builtin_tool_specs()
    }

    fn execute<'a>(
        &'a self,
        name: &'a str,
        input: Value,
        context: ToolContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        Box::pin(async move {
            match name {
                "memory.search" => {
                    let query = input
                        .get("query")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("")
                        .to_string();
                    let kind = match input.get("kind").and_then(Value::as_str) {
                        Some("user_preference") => Some(crate::agent::memory::MemoryKind::UserPreference),
                        Some("project_convention") => Some(crate::agent::memory::MemoryKind::ProjectConvention),
                        Some("confirmed_fact") => Some(crate::agent::memory::MemoryKind::ConfirmedFact),
                        Some("decision") => Some(crate::agent::memory::MemoryKind::Decision),
                        Some("open_question") => Some(crate::agent::memory::MemoryKind::OpenQuestion),
                        Some("schema_note") => Some(crate::agent::memory::MemoryKind::SchemaNote),
                        Some(_) => return Err("memory.search received an unknown kind".to_string()),
                        None => None,
                    };
                    let limit = input
                        .get("limit")
                        .and_then(Value::as_u64)
                        .map(|value| value as usize)
                        .unwrap_or(8);
                    let hits = crate::agent::memory::ProjectMemoryStore::search(
                        context.project_path,
                        context.project_id,
                        context.session_id.as_deref(),
                        &query,
                        kind,
                        limit,
                    )?;
                    serde_json::to_value(hits)
                        .map_err(|err| format!("Failed to serialize memory.search result: {err}"))
                }
                "memory.propose" => {
                    let session_id = context.session_id.as_deref().ok_or_else(|| {
                        "memory.propose requires an active session id".to_string()
                    })?;
                    let kind = match input.get("kind").and_then(Value::as_str) {
                        Some("user_preference") => crate::agent::memory::MemoryKind::UserPreference,
                        Some("project_convention") => crate::agent::memory::MemoryKind::ProjectConvention,
                        Some("confirmed_fact") => crate::agent::memory::MemoryKind::ConfirmedFact,
                        Some("decision") => crate::agent::memory::MemoryKind::Decision,
                        Some("open_question") => crate::agent::memory::MemoryKind::OpenQuestion,
                        Some("schema_note") => crate::agent::memory::MemoryKind::SchemaNote,
                        _ => return Err("memory.propose requires a valid kind".to_string()),
                    };
                    let scope = match input.get("scope").and_then(Value::as_str) {
                        Some("project") => crate::agent::memory::MemoryScope::Project,
                        Some("session") => crate::agent::memory::MemoryScope::Session,
                        _ => return Err("memory.propose requires scope=project or scope=session".to_string()),
                    };
                    let title = input
                        .get("title")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "memory.propose requires title".to_string())?;
                    let content = input
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "memory.propose requires content".to_string())?;
                    let reference_paths = input
                        .get("referencePaths")
                        .and_then(Value::as_array)
                        .map(|items| items.iter().filter_map(|value| value.as_str().map(|s| s.to_string())).collect());
                    let confidence = match input.get("confidence").and_then(Value::as_str) {
                        Some("user_confirmed") => crate::agent::memory::MemoryConfidence::UserConfirmed,
                        Some("evidence_backed") => crate::agent::memory::MemoryConfidence::EvidenceBacked,
                        _ => crate::agent::memory::MemoryConfidence::AgentSuggested,
                    };
                    let reason = input
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("Agent proposed based on current task");
                    let proposal = crate::agent::memory::ProjectMemoryStore::create_proposal(
                        context.project_path,
                        context.project_id,
                        Some(session_id),
                        kind,
                        scope,
                        title,
                        content,
                        confidence,
                        reference_paths,
                        reason,
                    )?;
                    serde_json::to_value(proposal)
                        .map_err(|err| format!("Failed to serialize memory.propose result: {err}"))
                }
                "memory.list" => {
                    let scope = input.get("scope").and_then(Value::as_str);
                    let project_id = input
                        .get("projectId")
                        .and_then(Value::as_str)
                        .unwrap_or(context.project_id);
                    let active = crate::agent::memory::ProjectMemoryStore::list_active(
                        context.project_path,
                        project_id,
                        context.session_id.as_deref(),
                    )?;
                    let proposals = crate::agent::memory::ProjectMemoryStore::proposals(context.project_path, project_id)?;
                    Ok(serde_json::json!({
                        "active": active
                            .into_iter()
                            .filter(|memory| match scope {
                                Some("project") => matches!(memory.scope, crate::agent::memory::MemoryScope::Project),
                                Some("session") => matches!(memory.scope, crate::agent::memory::MemoryScope::Session),
                                _ => true,
                            })
                            .collect::<Vec<_>>(),
                        "proposals": proposals,
                    }))
                }
                "schema.inspect" => serde_json::to_value(
                    crate::commands::schema::get_compiled_schema(context.project_path)?,
                )
                .map_err(|err| format!("Failed to serialize schema.inspect result: {err}")),
                "schema.validate" => {
                    let schema = crate::commands::schema::get_compiled_schema(context.project_path)?;
                    serde_json::to_value(crate::commands::schema::audit_project_schema_for_api(
                        context.project_path,
                        &schema,
                    )?)
                    .map_err(|err| format!("Failed to serialize schema.validate result: {err}"))
                }
                "schema.propose_change" => {
                    let session_id = context
                        .session_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| "schema.propose_change requires an active session".to_string())?;
                    let proposed_schema = input
                        .get("proposedSchema")
                        .or_else(|| input.get("proposed_schema"))
                        .or_else(|| input.get("content"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| "schema.propose_change requires proposedSchema".to_string())?;
                    serde_json::to_value(crate::commands::schema::create_schema_proposal(
                        context.project_path,
                        context.project_id,
                        session_id,
                        proposed_schema.to_string(),
                    )?)
                    .map_err(|err| format!("Failed to serialize schema.propose_change result: {err}"))
                }
                "wiki.write_page" => {
                    let path = input
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "wiki.write_page requires path".to_string())?;
                    let content = input
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "wiki.write_page requires content".to_string())?;
                    // Default to true (ClaudeCode Write semantics: the tool
                    // is destructive by design). Pass allowOverwrite=false
                    // explicitly to opt into a create-only guard. The
                    // user-facing safety gate is the WikiWriteMode UI
                    // confirmation, not this model-discipline flag.
                    let allow_overwrite = input
                        .get("allowOverwrite")
                        .or_else(|| input.get("allow_overwrite"))
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    serde_json::to_value(write_wiki_page_with_activity(
                        context.project_path,
                        path,
                        content,
                        allow_overwrite,
                    )?)
                    .map_err(|err| format!("Failed to serialize wiki.write_page result: {err}"))
                }
                "wiki.search" => {
                    let query = tool_query(&input, "wiki.search")?;
                    let top_k = tool_top_k(&input);
                    let include_content = input
                        .get("includeContent")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    serde_json::to_value(
                        run_wiki_search(
                            context.project_path.to_string(),
                            query,
                            top_k,
                            include_content,
                            context.embedding_config,
                        )
                        .await?,
                    )
                    .map_err(|err| format!("Failed to serialize wiki.search result: {err}"))
                }
                "wiki.read_page" => {
                    let path = input
                        .get("path")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|path| !path.is_empty())
                        .ok_or_else(|| "wiki.read_page requires path".to_string())?;
                    let offset = input.get("offset").and_then(Value::as_u64).map(|v| v as usize);
                    let limit = input.get("limit").and_then(Value::as_u64).map(|v| v as usize);
                    let read = read_wiki_page(context.project_path, path, offset, limit)?;
                    let normalized_path = normalize_rel_path(path);
                    let mut knowledge_context = build_knowledge_context_index(context.project_path)
                        .remove(&normalized_path);
                    attach_latest_version(
                        context.project_path,
                        &normalized_path,
                        &mut knowledge_context,
                    );
                    serde_json::to_value(json!({
                        "path": read.path,
                        "content": read.content,
                        "startLine": read.start_line,
                        "endLine": read.end_line,
                        "totalLines": read.total_lines,
                        "knowledgeContext": knowledge_context,
                    }))
                    .map_err(|err| format!("Failed to serialize wiki.read_page result: {err}"))
                }
                "wiki.edit_page" => {
                    let path = input
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "wiki.edit_page requires path".to_string())?;
                    let old_string = input
                        .get("old_string")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "wiki.edit_page requires old_string".to_string())?;
                    let new_string = input
                        .get("new_string")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "wiki.edit_page requires new_string".to_string())?;
                    let replace_all = input
                        .get("replace_all")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    serde_json::to_value(edit_wiki_page_with_activity(
                        context.project_path,
                        path,
                        old_string,
                        new_string,
                        replace_all,
                    )?)
                    .map_err(|err| format!("Failed to serialize wiki.edit_page result: {err}"))
                }
                "workspace.write_file" => {
                    let path = input
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "workspace.write_file requires path".to_string())?;
                    let content = input
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "workspace.write_file requires content".to_string())?;
                    serde_json::to_value(write_workspace_file(context.project_path, path, content)?)
                        .map_err(|err| {
                            format!("Failed to serialize workspace.write_file result: {err}")
                        })
                }
                "workspace.append_file" => {
                    let path = input
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "workspace.append_file requires path".to_string())?;
                    let content = input
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "workspace.append_file requires content".to_string())?;
                    serde_json::to_value(append_workspace_file(
                        context.project_path,
                        path,
                        content,
                    )?)
                    .map_err(|err| {
                        format!("Failed to serialize workspace.append_file result: {err}")
                    })
                }
                "workspace.read_file" => {
                    let path = input
                        .get("path")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|path| !path.is_empty())
                        .ok_or_else(|| "workspace.read_file requires path".to_string())?;
                    let offset = input.get("offset").and_then(Value::as_u64).map(|v| v as usize);
                    let limit = input.get("limit").and_then(Value::as_u64).map(|v| v as usize);
                    serde_json::to_value(read_workspace_file(
                        context.project_path,
                        path,
                        offset,
                        limit,
                    )?)
                    .map_err(|err| format!("Failed to serialize workspace.read_file result: {err}"))
                }
                "workspace.edit_file" => {
                    let path = input
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "workspace.edit_file requires path".to_string())?;
                    let old_string = input
                        .get("old_string")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "workspace.edit_file requires old_string".to_string())?;
                    let new_string = input
                        .get("new_string")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "workspace.edit_file requires new_string".to_string())?;
                    let replace_all = input
                        .get("replace_all")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    serde_json::to_value(edit_workspace_file_with_activity(
                        context.project_path,
                        path,
                        old_string,
                        new_string,
                        replace_all,
                    )?)
                    .map_err(|err| format!("Failed to serialize workspace.edit_file result: {err}"))
                }
                "source.search" => {
                    let query = tool_query(&input, "source.search")?.to_string();
                    let project_path = context.project_path.to_string();
                    let top_k = tool_top_k(&input);
                    // `search_sources` walks the filesystem synchronously.
                    // Keep it off Tokio worker threads so a large source tree
                    // cannot stall unrelated Agent/API work.
                    let references = tokio::task::spawn_blocking(move || {
                        search_sources(&project_path, &query, top_k)
                    })
                    .await
                    .map_err(|err| format!("source.search worker failed: {err}"))??;
                    serde_json::to_value(references)
                        .map_err(|err| format!("Failed to serialize source.search result: {err}"))
                }
                "graph.search" => {
                    let query = tool_query(&input, "graph.search")?.to_string();
                    let project_path = context.project_path.to_string();
                    let top_k = tool_top_k(&input);
                    // Graph search also performs synchronous markdown walks.
                    // Run it in the blocking pool for the same reason as
                    // `source.search`.
                    let references = tokio::task::spawn_blocking(move || {
                        search_graph(&project_path, &query, top_k)
                    })
                    .await
                    .map_err(|err| format!("graph.search worker failed: {err}"))??;
                    serde_json::to_value(references)
                        .map_err(|err| format!("Failed to serialize graph.search result: {err}"))
                }
                "web.search" => {
                    let query = tool_query(&input, "web.search")?;
                    serde_json::to_value(
                        run_web_search(query, context.web_search_config, tool_top_k(&input))
                            .await?,
                    )
                    .map_err(|err| format!("Failed to serialize web.search result: {err}"))
                }
                "anytxt.search" => {
                    let query = tool_query(&input, "anytxt.search")?;
                    serde_json::to_value(
                        run_anytxt_search(query, context.anytxt_config, tool_top_k(&input)).await?,
                    )
                    .map_err(|err| format!("Failed to serialize anytxt.search result: {err}"))
                }
                "deep_research.run" => {
                    let query = tool_query(&input, "deep_research.run")?;
                    serde_json::to_value(json!({
                        "query": query,
                        "status": "orchestrated_by_agent_runtime",
                    }))
                    .map_err(|err| format!("Failed to serialize deep_research.run result: {err}"))
                }
                "shell.exec" => {
                    let command = input
                        .get("command")
                        .or_else(|| input.get("query"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            // Mirror the runtime.rs helper so the registry
                            // path also surfaces which input keys were
                            // actually present — helps debug tools that
                            // invoke shell.exec via tool_registry.execute
                            // (rather than the agent loop) and arrive
                            // with the wrong field name.
                            let received = [
                                ("command", input.get("command").is_some()),
                                ("query", input.get("query").is_some()),
                                ("path", input.get("path").is_some()),
                                ("content", input.get("content").is_some()),
                                ("title", input.get("title").is_some()),
                                ("skill", input.get("skill").is_some()),
                            ]
                            .into_iter()
                            .filter_map(|(name, present)| present.then(|| name))
                            .collect::<Vec<_>>()
                            .join(", ");
                            format!(
                                "shell.exec requires command (input had fields: [{}])",
                                if received.is_empty() {
                                    "<none>".to_string()
                                } else {
                                    received
                                }
                            )
                        })?;
                    let timeout_secs = input
                        .get("timeoutSeconds")
                        .or_else(|| input.get("timeout_seconds"))
                        .and_then(Value::as_u64)
                        .unwrap_or(SHELL_EXEC_TIMEOUT_SECS)
                        .clamp(1, SHELL_EXEC_TIMEOUT_SECS);
                    serde_json::to_value(
                        run_shell_exec(context.project_path, command, timeout_secs).await?,
                    )
                    .map_err(|err| format!("Failed to serialize shell.exec result: {err}"))
                }
                other => Err(format!("Unknown Agent tool: {other}")),
            }
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiSearchToolOutput {
    pub mode: String,
    pub token_hits: usize,
    pub vector_hits: usize,
    pub graph_hits: usize,
    pub references: Vec<AgentReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellExecToolOutput {
    pub command: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    #[serde(default)]
    pub generated_files: Vec<WorkspaceWriteOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWriteOutput {
    pub path: String,
    pub bytes: usize,
    #[serde(default)]
    pub existed_before: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_content: Option<String>,
}

/// Output of `wiki.read_page` (and `workspace.read_file`). The
/// `content` field is the file body with line numbers baked in
/// (`   N\t...`) so subsequent `wiki.edit_page` / `workspace.edit_file`
/// calls can quote exact substrings including whitespace. `start_line`
/// / `end_line` / `total_lines` describe the slice returned so the
/// agent can request the next chunk without re-counting.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiReadOutput {
    pub path: String,
    pub content: String,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
}

/// Output of `wiki.edit_page` and `workspace.edit_file`. Mirrors
/// `WikiWriteOutput` (an AgentReference + optional rollback snapshot)
/// plus the count of replacements applied — useful for verification
/// when `replace_all=true` was passed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiEditOutput {
    pub reference: AgentReference,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_content: Option<String>,
    pub replacements: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiWriteOutput {
    #[serde(flatten)]
    pub reference: AgentReference,
    #[serde(default)]
    pub existed_before: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchConfig {
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub ollama_url: Option<String>,
    #[serde(default)]
    pub sear_xng_url: Option<String>,
    #[serde(default)]
    pub sear_xng_categories: Option<Vec<String>>,
    #[serde(default)]
    pub serp_api_engine: Option<String>,
    #[serde(default)]
    pub provider_configs: Option<BTreeMap<String, WebSearchProviderOverride>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchProviderOverride {
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub ollama_url: Option<String>,
    #[serde(default)]
    pub sear_xng_url: Option<String>,
    #[serde(default)]
    pub sear_xng_categories: Option<Vec<String>>,
    #[serde(default)]
    pub serp_api_engine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnyTxtConfig {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub filter_dir: Option<String>,
    #[serde(default)]
    pub filter_ext: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

impl WebSearchConfig {
    fn resolved(&self) -> Self {
        let provider = self.provider.trim().to_ascii_lowercase();
        let Some(override_cfg) = self
            .provider_configs
            .as_ref()
            .and_then(|configs| configs.get(&provider))
        else {
            return self.clone();
        };
        Self {
            provider: self.provider.clone(),
            api_key: override_cfg
                .api_key
                .clone()
                .unwrap_or_else(|| self.api_key.clone()),
            ollama_url: override_cfg
                .ollama_url
                .clone()
                .or_else(|| self.ollama_url.clone()),
            sear_xng_url: override_cfg
                .sear_xng_url
                .clone()
                .or_else(|| self.sear_xng_url.clone()),
            sear_xng_categories: override_cfg
                .sear_xng_categories
                .clone()
                .or_else(|| self.sear_xng_categories.clone()),
            serp_api_engine: override_cfg
                .serp_api_engine
                .clone()
                .or_else(|| self.serp_api_engine.clone()),
            provider_configs: self.provider_configs.clone(),
        }
    }
}

// Keep the spec list close to the executor even though the current planner
// still uses fixed tool names. API/MCP tool discovery and future native
// tool-calling should use this list instead of duplicating tool metadata.
#[allow(dead_code)]
pub fn builtin_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "wiki.search".to_string(),
            description: "Search generated LLM Wiki pages using backend keyword/vector retrieval."
                .to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 10 }
                },
                "required": ["query"]
            })),
        },
        ToolSpec {
            name: "wiki.read_page".to_string(),
            description: "Read a project wiki markdown page by project-relative path. \
                          Optionally paginate with offset + limit (1-indexed line numbers) for large pages. \
                          The response is prefixed with `   N\\t` line numbers (cat -n style) so subsequent \
                          wiki.edit_page calls can quote exact substrings including whitespace. \
                          Without offset/limit the entire page is returned up to ~200 lines \
                          (larger pages get truncated)."
                .to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "path":   { "type": "string", "description": "Project-relative wiki/ path, e.g. wiki/concepts/transformers.md" },
                    "offset": { "type": "integer", "minimum": 1, "description": "Optional. 1-indexed start line. Defaults to 1." },
                    "limit":  { "type": "integer", "minimum": 1, "description": "Optional. Number of lines to return. Defaults to 200." }
                },
                "required": ["path"]
            })),
        },
        ToolSpec {
            name: "source.search".to_string(),
            description:
                "Search raw source files stored under raw/sources for exact keyword snippets."
                    .to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 10 }
                },
                "required": ["query"]
            })),
        },
        ToolSpec {
            name: "web.search".to_string(),
            description: "Search external web sources when the user enables web search."
                .to_string(),
            effects: vec![ToolEffect::Network],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 10 }
                },
                "required": ["query"]
            })),
        },
        ToolSpec {
            name: "graph.search".to_string(),
            description: "Retrieve graph relationships, neighbors, backlinks, dependencies, and connections between project entities. Use concise entity or concept names rather than a full question."
                .to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 10 }
                },
                "required": ["query"]
            })),
        },
        ToolSpec {
            name: "anytxt.search".to_string(),
            description: "Search files indexed by an AnyTXT JSON-RPC service.".to_string(),
            effects: vec![ToolEffect::Network, ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "topK": { "type": "integer", "minimum": 1, "maximum": 10 }
                },
                "required": ["query"]
            })),
        },
        ToolSpec {
            name: "deep_research.run".to_string(),
            description:
                "Collect broader external/local evidence for deep research turns before synthesis."
                    .to_string(),
            effects: vec![ToolEffect::Network, ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "sources": {
                        "type": "array",
                        "items": { "enum": ["web", "anytxt", "wiki", "source"] }
                    }
                },
                "required": ["query"]
            })),
        },
        ToolSpec {
            name: "memory.search".to_string(),
            description: "Search project-scoped memory entries (preferences, conventions, confirmed facts, decisions, open questions, schema notes). Read-only. The returned entries are already user-confirmed and safe to cite.".to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Optional query; if empty, returns highest-confidence entries." },
                    "kind": { "type": "string", "enum": ["user_preference", "project_convention", "confirmed_fact", "decision", "open_question", "schema_note"] },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 32 }
                },
                "additionalProperties": false
            })),
        },
        ToolSpec {
            name: "memory.propose".to_string(),
            description: "Create a pending memory candidate. Never claim to save anything until the user explicitly accepts the proposal in the Memory confirmation UI. Use only when the user clearly states a stable preference, confirms a project decision, asks you to remember something, or a statement is backed by a confirmed wiki/reference.".to_string(),
            effects: vec![ToolEffect::Write],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["user_preference", "project_convention", "confirmed_fact", "decision", "open_question", "schema_note"] },
                    "scope": { "type": "string", "enum": ["project", "session"], "description": "project is cross-session; session lives only for the current Agent session." },
                    "title": { "type": "string" },
                    "content": { "type": "string" },
                    "confidence": { "type": "string", "enum": ["user_confirmed", "evidence_backed", "agent_suggested"] },
                    "reason": { "type": "string" },
                    "referencePaths": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["kind", "scope", "title", "content"]
            })),
        },
        ToolSpec {
            name: "memory.list".to_string(),
            description: "List active and pending memory entries for the current project. Read-only; useful for management UIs and for surfacing proposals that still need user confirmation.".to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "scope": { "type": "string", "enum": ["project", "session"] }
                },
                "additionalProperties": false
            })),
        },
        ToolSpec {
            name: "schema.inspect".to_string(),
            description: "Read the compiled project schema version, Page Types routing, and diagnostics. This is read-only. Use it before proposing a schema change.".to_string(),
            effects: vec![ToolEffect::Read],
            parameters: None,
        },
        ToolSpec {
            name: "schema.validate".to_string(),
            description: "Audit existing wiki pages against the current project schema. This is read-only: it reports affected paths and never migrates pages.".to_string(),
            effects: vec![ToolEffect::Read],
            parameters: None,
        },
        ToolSpec {
            name: "schema.propose_change".to_string(),
            description: "Create a pending, user-reviewable proposal for replacing the complete root schema.md. Never claims to apply the change; the user must explicitly approve it through the Schema proposal UI. Use only when the user asks to evolve the project schema or confirms a convention should be formalized.".to_string(),
            effects: vec![ToolEffect::Write],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": { "proposedSchema": { "type": "string", "description": "Complete proposed schema.md Markdown content." } },
                "required": ["proposedSchema"]
            })),
        },
        ToolSpec {
            name: "wiki.write_page".to_string(),
            description:
                "Create or overwrite a Markdown wiki page under wiki/. The path MUST start with \"wiki/\" and end with \".md\"; otherwise the call is rejected. \
                 By default, existing files ARE overwritten (ClaudeCode Write semantics — destructive by design). \
                 Pass allowOverwrite=false only when you specifically want a create-only guard. \
                 For long pages that may exceed a single model response, write a smaller initial page with wiki.write_page, then keep extending it with shell.exec + cat >> (the workspace heredoc pattern). \
                 Do not put an entire long Markdown page in one wiki.write_page content field."
                    .to_string(),
            effects: vec![ToolEffect::Write],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Project-relative path. MUST start with \"wiki/\" and end with \".md\"; for example wiki/queries/new-page.md. Paths that omit the wiki/ prefix or that do not end with .md are rejected."
                    },
                    "content": { "type": "string" },
                    "allowOverwrite": {
                        "type": "boolean",
                        "description": "Defaults to true (overwrite existing page). Set to false only when you specifically want a create-only guard."
                    }
                },
                "required": ["path", "content"]
            })),
        },
        ToolSpec {
            name: "wiki.edit_page".to_string(),
            description:
                "Apply a targeted string replacement to a wiki markdown page (ClaudeCode Edit semantics). \
                 old_string must match exactly; new_string replaces it. \
                 By default the edit is REJECTED when old_string appears more than once — pass replace_all=true to batch-replace every occurrence. \
                 The file is read in full, edited, and rewritten atomically; an Undo version is recorded. \
                 Prefer this over wiki.write_page when you only need to change a few lines."
                    .to_string(),
            effects: vec![ToolEffect::Write],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "path":        { "type": "string", "description": "Project-relative wiki/ path (same constraints as wiki.write_page)." },
                    "old_string":  { "type": "string", "description": "Exact substring to replace. Must appear at least once." },
                    "new_string":  { "type": "string", "description": "Replacement text." },
                    "replace_all": { "type": "boolean", "description": "Default false. When true, replace every occurrence; when false (default), reject if old_string appears more than once." }
                },
                "required": ["path", "old_string", "new_string"]
            })),
        },
        ToolSpec {
            name: "llm.generate".to_string(),
            description: "Generate a final assistant answer from retrieved context.".to_string(),
            effects: vec![ToolEffect::Network],
            parameters: None,
        },
        ToolSpec {
            name: "skills.load".to_string(),
            description: "Load instruction-only project skills from .llm-wiki/skills.".to_string(),
            effects: vec![ToolEffect::Read],
            parameters: None,
        },
        ToolSpec {
            name: "skill.read_file".to_string(),
            description:
                "Read a text reference file from an active skill directory by relative path."
                    .to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "skill": {
                        "type": "string",
                        "description": "Optional active skill name; required when multiple skills are active."
                    },
                    "path": {
                        "type": "string",
                        "description": "Relative path inside the active skill directory, such as references/types.md."
                    }
                },
                "required": ["path"]
            })),
        },
        ToolSpec {
            name: "workspace.write_file".to_string(),
            description:
                "Write or overwrite a generated artifact file under the visible agent-workspace directory. \
                 Use this for any output file the user should see (HTML reports, SVG/PNG cover images, generated scripts, downloaded data dumps). \
                 For LARGE files (over ~6 KB of content), initialize with workspace.write_file and then continue with one or more workspace.append_file chunks instead of stuffing the whole thing into one write — a single content field that exceeds the model's token limit gets truncated mid-string. \
                 Generated scripts in agent-workspace can be invoked from shell.exec (`python script.py`, `bash run.sh`)."
                    .to_string(),
            effects: vec![ToolEffect::Write],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path under agent-workspace, such as cover-image/cover.svg."
                    },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            })),
        },
        ToolSpec {
            name: "workspace.append_file".to_string(),
            description:
                "Append content to an existing generated artifact under agent-workspace. Use after workspace.write_file for large HTML/PPT files or any content that would not fit in one model response. Each call adds one chunk; iterate until the file is complete."
                    .to_string(),
            effects: vec![ToolEffect::Write],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path under agent-workspace, matching the file being appended."
                    },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            })),
        },
        ToolSpec {
            name: "workspace.read_file".to_string(),
            description:
                "Read a file from agent-workspace by relative path. \
                 Same offset/limit + line-number semantics as wiki.read_page. \
                 Use this to inspect generated scripts before running them with shell.exec, \
                 or to verify multi-chunk writes before invoking the script."
                    .to_string(),
            effects: vec![ToolEffect::Read],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "path":   { "type": "string", "description": "Relative path under agent-workspace. Same constraints as workspace.write_file." },
                    "offset": { "type": "integer", "minimum": 1, "description": "Optional. 1-indexed start line. Defaults to 1." },
                    "limit":  { "type": "integer", "minimum": 1, "description": "Optional. Number of lines to return. Defaults to 200." }
                },
                "required": ["path"]
            })),
        },
        ToolSpec {
            name: "workspace.edit_file".to_string(),
            description:
                "Apply a targeted string replacement to a file in agent-workspace (ClaudeCode Edit semantics for workspace files). \
                 Same uniqueness rules as wiki.edit_page: old_string must match exactly; the edit is rejected when \
                 old_string appears more than once unless replace_all=true. \
                 Use to fix a small bug in a generated script or update a template token without rewriting the whole file."
                    .to_string(),
            effects: vec![ToolEffect::Write],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "path":        { "type": "string", "description": "Relative path under agent-workspace. Same constraints as workspace.write_file." },
                    "old_string":  { "type": "string", "description": "Exact substring to replace. Must appear at least once." },
                    "new_string":  { "type": "string", "description": "Replacement text." },
                    "replace_all": { "type": "boolean", "description": "Default false. When true, replace every occurrence; when false (default), reject if old_string appears more than once." }
                },
                "required": ["path", "old_string", "new_string"]
            })),
        },
        ToolSpec {
            name: "shell.exec".to_string(),
            description:
                "Run a shell command for code research, library introspection, or any command-line work the user asks for. \
                 The process runs with cwd = <project>/agent-workspace/ — use relative paths to reference project files. \
                 Field name in the action JSON MUST be `command` (not `path` / `content` / `query`). \
                 For Enhanced shell mode (the default in Settings): common dev tools (cat, head, grep, rg, sed, awk, find, jq, python, pip, uv, git, node, npm, cargo, go, etc.) are auto-approved even when arguments point to site-packages or other external paths; only network clients (curl, wget, ssh, scp), privilege escalation (sudo, doas), destructive system paths, and shell substitution ($() / backticks) always require explicit approval. \
                 PAYLOAD SIZE: keep the `command` string well under ~8 KB. Commands larger than that risk getting truncated mid-string by the model's token limit, which surfaces as \"Invalid or truncated Agent tool JSON\" — not a permission error. \
                 FOR LARGE SCRIPTS: do not inline multi-line Python or shell scripts in the `command` field. Write the script to agent-workspace via workspace.write_file first (e.g. `scripts/inspect.py`), then call shell.exec with `python scripts/inspect.py` or `bash scripts/run.sh`. This both fits the budget and lets you iterate on the script across iterations. \
                 USEFUL PATTERNS: `python -c \"import transformers; print(transformers.__file__)\"` to locate a package; `rg -l <symbol> <path>` to find files; `python -c \"import inspect; print(inspect.getsource(symbol))\"` to dump a class/function definition; pipe through `head`, `awk`, `jq` to trim large outputs to what matters."
                    .to_string(),
            effects: vec![ToolEffect::Read, ToolEffect::Process],
            parameters: Some(serde_json::json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to run. Use `command`, not `path` / `content` / `query`. Keep well under ~8 KB; for multi-line scripts, write the script to a workspace file first and invoke it."
                    },
                    "timeoutSeconds": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": SHELL_EXEC_TIMEOUT_SECS,
                        "description": "Optional. Defaults to 30s. Raise for known long-running commands (e.g. package builds)."
                    }
                },
                "required": ["command"]
            })),
        },
    ]
}

fn tool_query<'a>(input: &'a Value, tool: &str) -> Result<&'a str, String> {
    input
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .ok_or_else(|| format!("{tool} requires query"))
}

fn tool_top_k(input: &Value) -> usize {
    input
        .get("topK")
        .or_else(|| input.get("top_k"))
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(5)
        .clamp(1, 10)
}

pub fn write_wiki_page_with_options(
    project_path: &str,
    rel_path: &str,
    content: &str,
    allow_overwrite: bool,
) -> Result<AgentReference, String> {
    Ok(write_wiki_page_with_activity(project_path, rel_path, content, allow_overwrite)?.reference)
}

pub(crate) fn wiki_page_exists(project_path: &str, rel_path: &str) -> Result<bool, String> {
    let rel = normalize_wiki_write_path(rel_path)?;
    Ok(safe_project_join(project_path, &rel)?.is_file())
}

pub(crate) fn write_wiki_page_with_activity(
    project_path: &str,
    rel_path: &str,
    content: &str,
    allow_overwrite: bool,
) -> Result<WikiWriteOutput, String> {
    if content.len() > MAX_WRITE_PAGE_BYTES {
        return Err("wiki.write_page content is too large".to_string());
    }
    let rel = normalize_wiki_write_path(rel_path)?;
    let path = safe_project_join(project_path, &rel)?;
    if let Some(parent) = path.parent() {
        // Check the deepest existing ancestor before creating directories. If a
        // project already contains a symlink under `wiki/`, this prevents even
        // empty intermediate directories from being created outside the project.
        ensure_existing_ancestor_bound(project_path, parent)?;
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create wiki page directory: {err}"))?;
        ensure_project_bound_path(project_path, parent)?;
    }
    // Create-only by default. Prompt injection in retrieved context must not be
    // able to silently truncate an existing wiki page.
    if path.exists() && !allow_overwrite {
        return Err(
            "wiki.write_page refuses to overwrite an existing page without allowOverwrite=true"
                .to_string(),
        );
    }
    let existed_before = path.is_file();
    let previous_content = workspace_rollback_snapshot(&path);
    crate::commands::file_history::record_file_version(&path, "baseline", "before.wiki.write_page");
    fs::write(&path, content).map_err(|err| format!("Failed to write wiki page: {err}"))?;
    crate::commands::file_history::record_file_version(&path, "agent", "wiki.write_page");
    Ok(WikiWriteOutput {
        reference: AgentReference {
            title: extract_markdown_title(content).unwrap_or_else(|| {
                Path::new(&rel)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Wiki page")
                    .replace('-', " ")
            }),
            path: rel.clone(),
            kind: "wiki".to_string(),
            snippet: Some(trim_text(&collapse_markdown_preview(content), 500))
                .filter(|value| !value.trim().is_empty()),
            score: None,
            knowledge_context: None,
        },
        existed_before,
        previous_content,
    })
}

fn write_workspace_file(
    project_path: &str,
    rel_path: &str,
    content: &str,
) -> Result<WorkspaceWriteOutput, String> {
    if content.len() > MAX_WORKSPACE_WRITE_BYTES {
        return Err("workspace.write_file content is too large".to_string());
    }
    let (rel, path) =
        resolve_workspace_write_target(project_path, rel_path, "workspace.write_file")?;
    if path
        .symlink_metadata()
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("workspace.write_file refuses to overwrite a symlink".to_string());
    }
    let existed_before = path.is_file();
    let previous_content = workspace_rollback_snapshot(&path);
    crate::commands::file_history::record_file_version(
        &path,
        "baseline",
        "before.workspace.write_file",
    );
    fs::write(&path, content).map_err(|err| format!("workspace.write_file failed: {err}"))?;
    crate::commands::file_history::record_file_version(&path, "agent", "workspace.write_file");
    Ok(WorkspaceWriteOutput {
        path: format!("{AGENT_WORKSPACE_DIR}/{rel}"),
        bytes: content.len(),
        existed_before,
        previous_content,
    })
}

fn append_workspace_file(
    project_path: &str,
    rel_path: &str,
    content: &str,
) -> Result<WorkspaceWriteOutput, String> {
    if content.len() > MAX_WORKSPACE_WRITE_BYTES {
        return Err("workspace.append_file content is too large".to_string());
    }
    let (rel, path) =
        resolve_workspace_write_target(project_path, rel_path, "workspace.append_file")?;
    if path
        .symlink_metadata()
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("workspace.append_file refuses to overwrite a symlink".to_string());
    }
    let existed_before = path.is_file();
    let previous_content = workspace_rollback_snapshot(&path);
    crate::commands::file_history::record_file_version(
        &path,
        "baseline",
        "before.workspace.append_file",
    );
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(content.as_bytes())
        })
        .map_err(|err| format!("workspace.append_file failed: {err}"))?;
    crate::commands::file_history::record_file_version(&path, "agent", "workspace.append_file");
    let bytes = fs::metadata(&path)
        .map(|metadata| metadata.len() as usize)
        .unwrap_or(content.len());
    Ok(WorkspaceWriteOutput {
        path: format!("{AGENT_WORKSPACE_DIR}/{rel}"),
        bytes,
        existed_before,
        previous_content,
    })
}

fn workspace_rollback_snapshot(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_WORKSPACE_ROLLBACK_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn resolve_workspace_write_target(
    project_path: &str,
    rel_path: &str,
    tool_name: &str,
) -> Result<(String, PathBuf), String> {
    let rel = normalize_workspace_write_path(rel_path)
        .map_err(|err| err.replace("workspace.write_file", tool_name))?;
    let project = Path::new(project_path);
    if !project.is_dir() {
        return Err(format!("{tool_name} project directory is not available"));
    }
    let workspace = agent_workspace_path(project);
    fs::create_dir_all(&workspace)
        .map_err(|err| format!("{tool_name} failed to create workspace: {err}"))?;
    ensure_project_bound_path(project_path, &workspace)?;
    let path = workspace.join(&rel);
    if let Some(parent) = path.parent() {
        ensure_existing_ancestor_bound(project_path, parent)?;
        fs::create_dir_all(parent)
            .map_err(|err| format!("{tool_name} failed to create directory: {err}"))?;
        ensure_project_bound_path(project_path, parent)?;
    }
    Ok((rel, path))
}

/// Resolve a workspace-relative read path. Same path constraints as
/// `resolve_workspace_write_target` (no `..`, no symlinks, no `wiki/`
/// / `raw/` prefix) but does NOT create missing directories — read
/// fails fast if the target doesn't exist.
fn resolve_workspace_read_target(
    project_path: &str,
    rel_path: &str,
    tool_name: &str,
) -> Result<(String, PathBuf), String> {
    let rel = normalize_workspace_write_path(rel_path)
        .map_err(|err| err.replace("workspace.write_file", tool_name))?;
    let project = Path::new(project_path);
    if !project.is_dir() {
        return Err(format!("{tool_name} project directory is not available"));
    }
    let workspace = agent_workspace_path(project);
    ensure_project_bound_path(project_path, &workspace)?;
    let path = workspace.join(&rel);
    ensure_project_bound_path(project_path, &path)?;
    Ok((rel, path))
}

pub async fn run_wiki_search(
    project_path: String,
    query: &str,
    top_k: usize,
    include_content: bool,
    embedding_config: Option<SearchEmbeddingConfig>,
) -> Result<WikiSearchToolOutput, String> {
    let query_embedding = search::resolve_query_embedding(query, None, embedding_config).await?;
    let search = search::search_project_inner(
        project_path.clone(),
        query.to_string(),
        top_k,
        include_content,
        query_embedding,
    )
    .await?;
    let project_for_context = project_path.clone();
    let context_index =
        tokio::task::spawn_blocking(move || build_knowledge_context_index(&project_for_context))
            .await
            .map_err(|err| format!("wiki.search graph context worker failed: {err}"));
    // Retrieval must remain useful if optional graph enrichment fails. The
    // search result is the source of truth; context is a bounded enhancement.
    let mut context_index = context_index.unwrap_or_default();
    let references = search
        .results
        .iter()
        .map(|result| {
            let normalized_path = normalize_rel_path(&result.path);
            let mut knowledge_context = context_index.remove(&normalized_path);
            if let Some(context) = knowledge_context.as_mut() {
                context.related_to = result.graph_related_to.clone();
            }
            attach_latest_version(&project_path, &normalized_path, &mut knowledge_context);
            AgentReference {
                title: result.title.clone(),
                path: result.path.clone(),
                kind: if result.graph_related_to.is_empty() {
                    "wiki".to_string()
                } else {
                    "graph".to_string()
                },
                snippet: Some(result.snippet.clone()).filter(|s| !s.trim().is_empty()),
                score: Some(result.score),
                knowledge_context,
            }
        })
        .collect();
    Ok(WikiSearchToolOutput {
        mode: search.mode,
        token_hits: search.token_hits,
        vector_hits: search.vector_hits,
        graph_hits: search.graph_hits,
        references,
    })
}

async fn run_shell_exec(
    project_path: &str,
    command: &str,
    timeout_secs: u64,
) -> Result<ShellExecToolOutput, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("shell.exec command is empty".to_string());
    }
    if command.chars().count() > MAX_SHELL_COMMAND_CHARS {
        return Err("shell.exec command is too long".to_string());
    }
    let cwd = Path::new(project_path);
    if !cwd.is_dir() {
        return Err("shell.exec project directory is not available".to_string());
    }
    let workspace = agent_workspace_path(cwd);
    fs::create_dir_all(&workspace)
        .map_err(|err| format!("shell.exec failed to create {AGENT_WORKSPACE_DIR}: {err}"))?;
    ensure_project_bound_path(project_path, &workspace)?;
    let before_files = snapshot_workspace_files(&workspace);
    #[cfg(windows)]
    let mut child = {
        // Prefer Git Bash when it's available — it gives the agent a real
        // POSIX-ish environment (rg, sed/awk semantics, $() substitution
        // behavior, /usr/bin paths), which is what most Python/Rust/JS
        // toolchains are designed against. Fall back to cmd.exe if bash
        // isn't on PATH so the feature degrades cleanly on machines that
        // don't have Git for Windows installed.
        let bash_program = resolve_git_bash_program().unwrap_or_else(|| {
            std::env::var_os("ComSpec").unwrap_or_else(|| "cmd".into())
        });
        let using_bash = program_path_looks_like_bash(&bash_program);
        let mut cmd = Command::new(bash_program);
        if using_bash {
            // Git Bash expects `-c` (single-letter) on Windows just like
            // on POSIX. `bash.exe` from msys2/git-for-windows accepts both
            // styles, but `-c` is portable.
            cmd.args(["-c", command]);
        } else {
            cmd.args(["/C", command]);
        }
        cmd
    };
    #[cfg(not(windows))]
    let mut child = {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", command]);
        cmd
    };
    apply_sanitized_shell_env(&mut child, project_path, &workspace);
    child
        .current_dir(&workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = child
        .spawn()
        .map_err(|err| format!("shell.exec failed to start: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "shell.exec failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "shell.exec failed to capture stderr".to_string())?;
    let stdout_task = tokio::spawn(read_limited_output(stdout, MAX_SHELL_OUTPUT_CHARS));
    let stderr_task = tokio::spawn(read_limited_output(stderr, MAX_SHELL_OUTPUT_CHARS));
    let status = timeout(Duration::from_secs(timeout_secs), child.wait()).await;
    let (exit_code, timed_out, timeout_message) = match status {
        Ok(Ok(status)) => (status.code(), false, None),
        Ok(Err(err)) => return Err(format!("shell.exec failed while waiting: {err}")),
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            (
                None,
                true,
                Some(format!("Command timed out after {timeout_secs}s")),
            )
        }
    };
    let stdout = await_shell_output(stdout_task, "stdout").await?;
    let mut stderr = await_shell_output(stderr_task, "stderr").await?;
    if let Some(message) = timeout_message {
        if !stderr.is_empty() {
            stderr.push('\n');
        }
        stderr.push_str(&message);
    }
    let generated_files = changed_workspace_files(&workspace, before_files);
    for output in &generated_files {
        if let Some(relative) = output.path.strip_prefix(&format!("{AGENT_WORKSPACE_DIR}/")) {
            crate::commands::file_history::record_file_version(
                &workspace.join(relative),
                "agent",
                "shell.exec",
            );
        }
    }
    Ok(ShellExecToolOutput {
        command: command.to_string(),
        exit_code,
        stdout,
        stderr,
        timed_out,
        generated_files,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkspaceFileSnapshot {
    len: u64,
    modified: Option<SystemTime>,
    content_hash: Option<u64>,
}

fn snapshot_workspace_files(workspace: &Path) -> BTreeMap<String, WorkspaceFileSnapshot> {
    let mut files = BTreeMap::new();
    for entry in WalkDir::new(workspace).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(workspace) else {
            continue;
        };
        let Some(rel) = rel.to_str().map(|value| value.replace('\\', "/")) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        files.insert(
            rel,
            WorkspaceFileSnapshot {
                len: metadata.len(),
                modified: metadata.modified().ok(),
                content_hash: workspace_file_content_hash(entry.path(), metadata.len()),
            },
        );
    }
    files
}

fn workspace_file_content_hash(path: &Path, len: u64) -> Option<u64> {
    // Shell-generated artifacts can be rewritten faster than some filesystems
    // update mtimes, especially on Windows/external/network volumes. A bounded
    // content signature prevents same-size rewrites from disappearing from the
    // generated-output list without turning every shell command into an
    // unbounded full-workspace read.
    const FULL_HASH_LIMIT_BYTES: u64 = 8 * 1024 * 1024;
    const EDGE_SAMPLE_BYTES: u64 = 64 * 1024;

    let mut file = fs::File::open(path).ok()?;
    let mut hasher = DefaultHasher::new();
    len.hash(&mut hasher);
    if len <= FULL_HASH_LIMIT_BYTES {
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).ok()?;
        bytes.hash(&mut hasher);
    } else {
        let sample = EDGE_SAMPLE_BYTES as usize;
        let mut head = vec![0_u8; sample];
        file.read_exact(&mut head).ok()?;
        head.hash(&mut hasher);
        file.seek(SeekFrom::End(-(EDGE_SAMPLE_BYTES as i64))).ok()?;
        let mut tail = vec![0_u8; sample];
        file.read_exact(&mut tail).ok()?;
        tail.hash(&mut hasher);
    }
    Some(hasher.finish())
}

fn changed_workspace_files(
    workspace: &Path,
    before: BTreeMap<String, WorkspaceFileSnapshot>,
) -> Vec<WorkspaceWriteOutput> {
    let after = snapshot_workspace_files(workspace);
    after
        .into_iter()
        .filter_map(|(rel, snapshot)| {
            if before.get(&rel) == Some(&snapshot) {
                return None;
            }
            Some(WorkspaceWriteOutput {
                path: format!("{AGENT_WORKSPACE_DIR}/{rel}"),
                bytes: snapshot.len as usize,
                existed_before: before.contains_key(&rel),
                previous_content: None,
            })
        })
        .take(MAX_SHELL_GENERATED_FILES)
        .collect()
}

async fn await_shell_output(mut handle: JoinHandle<String>, label: &str) -> Result<String, String> {
    match timeout(
        Duration::from_secs(SHELL_OUTPUT_DRAIN_TIMEOUT_SECS),
        &mut handle,
    )
    .await
    {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(err)) => Err(format!("shell.exec {label} task failed: {err}")),
        Err(_) => {
            handle.abort();
            Ok(format!(
                "[{label} output was still open after command exit and was truncated]"
            ))
        }
    }
}

fn apply_sanitized_shell_env(command: &mut Command, project_path: &str, workspace: &Path) {
    // This is environment minimization, not an OS sandbox. `shell.exec` is only
    // reachable after an exact user approval in the Agent runtime, and approved
    // commands can still access the user's normal filesystem through the shell.
    // Keep generated artifacts in `LLM_WIKI_AGENT_WORKSPACE`, but do not imply
    // stronger process isolation here without adding a real sandbox layer.
    command.env_clear();
    preserve_shell_env(command, &["PATH", "LANG", "LC_ALL", "LC_CTYPE"]);
    #[cfg(not(windows))]
    {
        preserve_shell_env(
            command,
            &[
                "HOME",
                "USER",
                "LOGNAME",
                "SHELL",
                "TMPDIR",
                "XDG_CONFIG_HOME",
                "XDG_CACHE_HOME",
                "XDG_DATA_HOME",
            ],
        );
    }
    #[cfg(windows)]
    {
        preserve_shell_env(
            command,
            &[
                "ComSpec",
                "SystemRoot",
                "WINDIR",
                "PATHEXT",
                "USERPROFILE",
                "USERNAME",
                "HOMEDRIVE",
                "HOMEPATH",
                "TEMP",
                "TMP",
                "APPDATA",
                "LOCALAPPDATA",
                "ProgramData",
            ],
        );
    }
    command.env("LLM_WIKI_PROJECT", project_path);
    command.env("LLM_WIKI_PROJECT_PATH", project_path);
    command.env("LLM_WIKI_AGENT_WORKSPACE", workspace);
}

fn preserve_shell_env(command: &mut Command, keys: &[&str]) {
    for key in keys {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

async fn read_limited_output<R>(mut reader: R, max_chars: usize) -> String
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut kept = Vec::new();
    let max_bytes = max_chars.saturating_mul(4);
    let mut buffer = [0_u8; 8192];
    loop {
        let Ok(n) = reader.read(&mut buffer).await else {
            break;
        };
        if n == 0 {
            break;
        }
        if kept.len() < max_bytes {
            let remaining = max_bytes - kept.len();
            kept.extend_from_slice(&buffer[..n.min(remaining)]);
        }
    }
    let mut text = String::from_utf8_lossy(&kept).to_string();
    if text.chars().count() > max_chars {
        text = trim_text(&text, max_chars);
    }
    text
}

#[cfg(windows)]
fn resolve_git_bash_program() -> Option<std::ffi::OsString> {
    // Probe PATH (and a couple of well-known install roots) for bash.exe.
    // Returning Some(...) means "we found a shell that isn't cmd.exe and
    // we'll use POSIX-style `-c` to dispatch the command". The fallback
    // to ComSpec in `run_shell_exec` covers the not-found case.
    let candidates = ["bash.exe", "bash"];
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for candidate in candidates {
                let full = dir.join(candidate);
                if full.is_file() {
                    return Some(full.into_os_string());
                }
            }
        }
    }
    // Common fixed install roots (Git for Windows, msys2 standalone, WSL
    // shim). These are last-resort fallbacks because PATH is normally
    // authoritative.
    let roots = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files\Git\mingw64\bin\bash.exe",
    ];
    for root in roots {
        if Path::new(root).is_file() {
            return Some(std::ffi::OsString::from(root));
        }
    }
    None
}

#[cfg(windows)]
fn program_path_looks_like_bash(program: &std::ffi::OsStr) -> bool {
    let lower = program.to_string_lossy().to_ascii_lowercase();
    lower.ends_with("bash.exe") || lower.ends_with("bash")
}

#[cfg(test)]
mod shell_program_tests {
    use super::{program_path_looks_like_bash, resolve_git_bash_program};

    #[cfg(windows)]
    #[test]
    fn resolve_git_bash_program_finds_bash_on_windows_when_present() {
        // If bash is genuinely on PATH (CI runners with Git for Windows,
        // dev machines with msys2, etc.), this returns Some(...). If not,
        // we accept None — the feature degrades to ComSpec via cmd.
        let resolved = resolve_git_bash_program();
        if let Some(path) = resolved {
            let lower = path.to_string_lossy().to_ascii_lowercase();
            assert!(
                lower.ends_with("bash.exe") || lower.ends_with("bash"),
                "expected bash path, got {path:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn program_path_looks_like_bash_recognizes_bash_forms() {
        use std::ffi::OsStr;

        assert!(program_path_looks_like_bash(OsStr::new("C:/Program Files/Git/bin/bash.exe")));
        assert!(program_path_looks_like_bash(OsStr::new("bash.exe")));
        assert!(program_path_looks_like_bash(OsStr::new("bash")));
        assert!(!program_path_looks_like_bash(OsStr::new("C:/Windows/System32/cmd.exe")));
        assert!(!program_path_looks_like_bash(OsStr::new("pwsh.exe")));
    }

    #[cfg(not(windows))]
    #[test]
    fn resolve_git_bash_program_is_only_defined_on_windows() {
        // On non-Windows hosts the helper isn't compiled; this is a
        // placeholder so the test binary still has something to run.
        let _ = std::env::var("PATH");
    }
}

pub async fn run_web_search(
    query: &str,
    config: Option<WebSearchConfig>,
    top_k: usize,
) -> Result<Vec<AgentReference>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let Some(config) = config else {
        return Err(
            "Web search is enabled for this turn but no search provider is configured.".to_string(),
        );
    };
    let config = config.resolved();
    let provider = config.provider.trim().to_ascii_lowercase();
    if provider.is_empty() || provider == "none" {
        return Err("Web search provider is not configured.".to_string());
    }
    let max_results = top_k.clamp(1, 20);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(WEB_SEARCH_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("Failed to build web search client: {err}"))?;
    let raw = match provider.as_str() {
        "firecrawl" => firecrawl_search(&client, query, max_results).await?,
        "searxng" => searxng_search(&client, query, &config, max_results).await?,
        "tavily" => tavily_search(&client, query, &config, max_results).await?,
        "ollama" => ollama_search(&client, query, &config, max_results).await?,
        "brave" => brave_search(&client, query, &config, max_results).await?,
        "serpapi" => serpapi_search(&client, query, &config, max_results).await?,
        other => {
            return Err(format!(
                "Web search provider '{other}' is not supported by the Rust Agent yet"
            ))
        }
    };
    Ok(web_items_to_references(raw, max_results))
}

pub async fn run_anytxt_search(
    query: &str,
    config: Option<AnyTxtConfig>,
    top_k: usize,
) -> Result<Vec<AgentReference>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let config = config.unwrap_or_default();
    if config.enabled == Some(false) {
        return Ok(Vec::new());
    }
    let endpoint = config
        .endpoint
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_ANYTXT_ENDPOINT)
        .trim()
        .trim_end_matches('/');
    let endpoint = normalize_anytxt_endpoint(endpoint);
    let limit = top_k
        .clamp(1, 100)
        .min(config.limit.unwrap_or(DEFAULT_ANYTXT_LIMIT).clamp(1, 100));
    // AnyTXT has its own query syntax. The caller may already have rewritten
    // natural language into keyword form, so do not run the source-search
    // tokenizer here; pass the pattern through unchanged.
    let pattern = query.to_string();
    let filter_dir = config.filter_dir.unwrap_or_default();
    let filter_ext = config
        .filter_ext
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "*".to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(WEB_SEARCH_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("Failed to build AnyTXT client: {err}"))?;
    let mut input = json!({
        "pattern": pattern,
        "filterExt": filter_ext,
        "lastModifyBegin": 0,
        "lastModifyEnd": ANYTXT_LAST_MODIFY_END,
        "limit": limit.to_string(),
        "offset": 0,
        "order": 0
    });
    if !filter_dir.trim().is_empty() {
        input["filterDir"] = Value::String(filter_dir);
    }
    let response = client
        .post(&endpoint)
        .header("Accept", "application/json")
        .json(&json!({
            "id": 1,
            "jsonrpc": "2.0",
            "method": "ATRpcServer.Searcher.V1.GetResult",
            "params": { "input": input }
        }))
        .send()
        .await
        .map_err(|err| {
            format!("AnyTXT search failed. Check that ATGUI.exe or the AnyTXT service is running at {endpoint}: {err}")
        })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read AnyTXT response: {err}"))?;
    if !status.is_success() {
        return Err(format!("AnyTXT HTTP {status}: {}", trim_text(&text, 300)));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| format!("AnyTXT returned invalid JSON: {}", trim_text(&text, 300)))?;
    if let Some(error) = value.get("error") {
        return Err(format!(
            "AnyTXT error: {}",
            trim_text(&error.to_string(), 300)
        ));
    }
    let mut references = Vec::new();
    for item in extract_anytxt_items(&value).into_iter().take(limit) {
        let fragment = if !item.fid.trim().is_empty() {
            get_anytxt_fragment(&client, &endpoint, &item.fid, &pattern)
                .await
                .unwrap_or_default()
        } else {
            String::new()
        };
        references.push(AgentReference {
            title: item.title,
            path: file_url_for_path(&item.path),
            kind: "anytxt".to_string(),
            snippet: Some(trim_text(
                if fragment.trim().is_empty() {
                    &item.snippet
                } else {
                    &fragment
                },
                1200,
            ))
            .filter(|s| !s.trim().is_empty()),
            score: None,
            knowledge_context: None,
        });
    }
    Ok(references)
}

#[derive(Debug, Clone)]
struct AnyTxtItem {
    fid: String,
    title: String,
    path: String,
    snippet: String,
}

fn extract_anytxt_items(value: &Value) -> Vec<AnyTxtItem> {
    let result = value.get("result").unwrap_or(value);
    let candidates = first_anytxt_array(
        result,
        &[
            &[][..],
            &["items"],
            &["files"],
            &["results"],
            &["list"],
            &["value"],
            &["data"],
            &["output"],
            &["output", "items"],
            &["output", "files"],
            &["output", "results"],
            &["output", "list"],
            &["output", "value"],
            &["output", "data"],
            &["data", "items"],
            &["data", "files"],
            &["data", "results"],
            &["data", "list"],
            &["data", "value"],
            &["data", "output"],
            &["data", "output", "items"],
            &["data", "output", "files"],
            &["data", "output", "results"],
            &["data", "output", "list"],
            &["data", "output", "value"],
        ],
    )
    .unwrap_or_default();
    let fields = first_anytxt_fields(
        result,
        &[
            &["field"][..],
            &["fields"],
            &["output", "field"],
            &["output", "fields"],
            &["data", "field"],
            &["data", "fields"],
            &["data", "output", "field"],
            &["data", "output", "fields"],
        ],
    )
    .unwrap_or_default();
    candidates
        .into_iter()
        .filter_map(|item| {
            let record = normalize_anytxt_record(item, &fields);
            let fid = string_field(&record, &["fid", "id", "fileId", "file_id"]);
            let raw_path = string_field(
                &record,
                &[
                    "path",
                    "file",
                    "filePath",
                    "file_path",
                    "fullPath",
                    "full_path",
                    "filename",
                    "fileName",
                    "name",
                ],
            );
            let path = if raw_path.is_empty() && !fid.is_empty() {
                format!("anytxt://{fid}")
            } else {
                raw_path
            };
            let title = string_field(&record, &["title", "name", "fileName", "filename"])
                .trim()
                .to_string();
            let title = if title.is_empty() {
                Path::new(&path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("AnyTXT result")
                    .to_string()
            } else {
                title
            };
            let snippet = string_field(
                &record,
                &[
                    "snippet",
                    "fragment",
                    "content",
                    "contents",
                    "text",
                    "summary",
                    "highlight",
                    "hitText",
                    "hit_text",
                ],
            );
            if path.is_empty() && snippet.is_empty() {
                None
            } else {
                Some(AnyTxtItem {
                    fid,
                    title,
                    path,
                    snippet,
                })
            }
        })
        .collect()
}

fn first_anytxt_array(value: &Value, paths: &[&[&str]]) -> Option<Vec<Value>> {
    for path in paths {
        let Some(candidate) = value_at_path(value, path) else {
            continue;
        };
        if let Some(items) = candidate.as_array() {
            return Some(items.clone());
        }
    }
    None
}

fn first_anytxt_fields(value: &Value, paths: &[&[&str]]) -> Option<Vec<String>> {
    for path in paths {
        let Some(candidate) = value_at_path(value, path) else {
            continue;
        };
        let Some(items) = candidate.as_array() else {
            continue;
        };
        let fields = items
            .iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if !fields.is_empty() {
            return Some(fields);
        }
    }
    None
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn normalize_anytxt_record(item: Value, fields: &[String]) -> serde_json::Map<String, Value> {
    match item {
        Value::Object(object) => object,
        Value::Array(row) if !fields.is_empty() => fields
            .iter()
            .cloned()
            .zip(row)
            .collect::<serde_json::Map<String, Value>>(),
        other => {
            let mut object = serde_json::Map::new();
            object.insert("text".to_string(), other);
            object
        }
    }
}

fn string_field(record: &serde_json::Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        let Some(value) = record.get(*key) else {
            continue;
        };
        if let Some(text) = value.as_str().filter(|text| !text.trim().is_empty()) {
            return text.trim().to_string();
        }
        if let Some(number) = value.as_i64() {
            return number.to_string();
        }
        if let Some(number) = value.as_u64() {
            return number.to_string();
        }
    }
    String::new()
}

async fn get_anytxt_fragment(
    client: &reqwest::Client,
    endpoint: &str,
    fid: &str,
    pattern: &str,
) -> Result<String, String> {
    let response = client
        .post(endpoint)
        .header("Accept", "application/json")
        .json(&json!({
            "id": 2,
            "jsonrpc": "2.0",
            "method": "ATRpcServer.Searcher.V1.GetFragment",
            "params": { "input": { "fid": fid, "pattern": pattern } }
        }))
        .send()
        .await
        .map_err(|err| format!("AnyTXT fragment failed: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read AnyTXT fragment response: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "AnyTXT fragment HTTP {status}: {}",
            trim_text(&text, 300)
        ));
    }
    let value: Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "AnyTXT fragment returned invalid JSON: {}",
            trim_text(&text, 300)
        )
    })?;
    if let Some(error) = value.get("error") {
        return Err(format!(
            "AnyTXT fragment error: {}",
            trim_text(&error.to_string(), 300)
        ));
    }
    Ok(extract_anytxt_fragment_text(
        value.get("result").unwrap_or(&Value::Null),
    ))
}

fn extract_anytxt_fragment_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .map(extract_anytxt_fragment_text)
            .filter(|item| !item.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    let Some(object) = value.as_object() else {
        return String::new();
    };
    for key in ["text", "fragment", "content", "snippet", "html"] {
        if let Some(text) = object.get(key).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    for key in ["output", "result", "data", "fragments", "items", "list"] {
        if let Some(next) = object.get(key) {
            let text = extract_anytxt_fragment_text(next);
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    String::new()
}

fn normalize_anytxt_endpoint(value: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        value.to_string()
    } else {
        format!("http://{value}")
    }
}

#[derive(Debug, Clone)]
struct WebSearchItem {
    title: String,
    url: String,
    snippet: String,
}

async fn firecrawl_search(
    client: &reqwest::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let response = client
        .post("https://api.firecrawl.dev/v2/search")
        .header("Accept", "application/json")
        .json(&json!({ "query": query, "limit": max_results }))
        .send()
        .await
        .map_err(|err| format!("Network error reaching Firecrawl Search: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read Firecrawl response: {err}"))?;
    let parsed: Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "Firecrawl search returned invalid JSON: {}",
            trim_text(&text, 300)
        )
    })?;
    if !status.is_success() || parsed.get("success").and_then(Value::as_bool) == Some(false) {
        let msg = parsed
            .get("error")
            .and_then(Value::as_str)
            .map(friendly_firecrawl_error)
            .unwrap_or_else(|| format!("Firecrawl search failed ({status})"));
        return Err(msg);
    }
    let items = extract_web_items(&parsed, &["data", "results"]);
    Ok(items.into_iter().map(normalize_web_result).collect())
}

async fn searxng_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let base = config
        .sear_xng_url
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| "SearXNG URL is required for web.search".to_string())?;
    let mut url = normalize_searxng_url(base)?;
    let categories = config
        .sear_xng_categories
        .clone()
        .unwrap_or_else(|| vec!["general".to_string()]);
    url.push_str(&format!(
        "?q={}&format=json&categories={}",
        url_encode(query),
        url_encode(&categories.join(","))
    ));
    let response = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| format!("Network error reaching SearXNG: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read SearXNG response: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "SearXNG search failed ({status}): {}",
            trim_text(&text, 300)
        ));
    }
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|_| format!("SearXNG returned invalid JSON: {}", trim_text(&text, 300)))?;
    let items = parsed
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .take(max_results)
        .map(normalize_web_result)
        .collect())
}

async fn tavily_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let key = required_api_key(config, "Tavily")?;
    let response = client
        .post("https://api.tavily.com/search")
        .json(&json!({
            "api_key": key,
            "query": query,
            "max_results": max_results,
            "search_depth": "advanced",
            "include_answer": false
        }))
        .send()
        .await
        .map_err(|err| format!("Network error reaching Tavily: {err}"))?;
    parse_web_json_response(response, "Tavily", |value| {
        value
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(normalize_web_result)
            .collect()
    })
    .await
}

async fn ollama_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let key = required_api_key(config, "Ollama")?;
    let base = config
        .ollama_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://ollama.com")
        .trim()
        .trim_end_matches('/');
    let url = format!("{base}/api/web_search");
    let response = client
        .post(url)
        .header("Accept", "application/json")
        .bearer_auth(key)
        .json(&json!({
            "query": query,
            "max_results": max_results
        }))
        .send()
        .await
        .map_err(|err| format!("Network error reaching Ollama Web Search: {err}"))?;
    parse_web_json_response(response, "Ollama Web Search", |value| {
        value
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(normalize_web_result)
            .collect()
    })
    .await
}

async fn brave_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let key = required_api_key(config, "Brave")?;
    let url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={}&count={}",
        url_encode(query),
        max_results.min(20)
    );
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .header("X-Subscription-Token", key)
        .send()
        .await
        .map_err(|err| format!("Network error reaching Brave Search: {err}"))?;
    parse_web_json_response(response, "Brave Search", |value| {
        value
            .get("web")
            .and_then(|web| web.get("results"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(normalize_web_result)
            .collect()
    })
    .await
}

async fn serpapi_search(
    client: &reqwest::Client,
    query: &str,
    config: &WebSearchConfig,
    max_results: usize,
) -> Result<Vec<WebSearchItem>, String> {
    let key = required_api_key(config, "SerpApi")?;
    let engine = config.serp_api_engine.as_deref().unwrap_or("google");
    let url = format!(
        "https://serpapi.com/search?engine={}&q={}&api_key={}&num={}",
        url_encode(engine),
        url_encode(query),
        url_encode(key),
        max_results
    );
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| format!("Network error reaching SerpApi: {err}"))?;
    parse_web_json_response(response, "SerpApi", |value| {
        for key in [
            "organic_results",
            "news_results",
            "images_results",
            "video_results",
            "videos_results",
            "shopping_results",
        ] {
            if let Some(items) = value.get(key).and_then(Value::as_array) {
                return items.iter().cloned().map(normalize_web_result).collect();
            }
        }
        Vec::new()
    })
    .await
}

async fn parse_web_json_response(
    response: reqwest::Response,
    provider: &str,
    parse: impl FnOnce(Value) -> Vec<WebSearchItem>,
) -> Result<Vec<WebSearchItem>, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read {provider} response: {err}"))?;
    if !status.is_success() {
        return Err(format!(
            "{provider} search failed ({status}): {}",
            trim_text(&text, 300)
        ));
    }
    let value: Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "{provider} returned invalid JSON: {}",
            trim_text(&text, 300)
        )
    })?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(format!("{provider} search failed: {error}"));
    }
    if let Some(message) = provider_payload_error(provider, &value) {
        return Err(message);
    }
    Ok(parse(value))
}

fn provider_payload_error(provider: &str, value: &Value) -> Option<String> {
    if provider == "Brave Search" && value.get("web").is_none() {
        let message = value.get("message").and_then(Value::as_str)?;
        return Some(format!("{provider} search failed: {message}"));
    }
    None
}

fn web_items_to_references(raw: Vec<WebSearchItem>, max_results: usize) -> Vec<AgentReference> {
    raw.into_iter()
        .take(max_results)
        .filter(|item| !item.url.trim().is_empty())
        .map(|item| AgentReference {
            title: item.title,
            path: item.url,
            kind: "web".to_string(),
            snippet: Some(item.snippet).filter(|s| !s.trim().is_empty()),
            score: None,
            knowledge_context: None,
        })
        .collect()
}

fn normalize_web_result(value: Value) -> WebSearchItem {
    let metadata = value.get("metadata");
    let title = value
        .get("title")
        .or_else(|| metadata.and_then(|m| m.get("title")))
        .and_then(Value::as_str)
        .unwrap_or("Untitled")
        .to_string();
    let url = value
        .get("url")
        .or_else(|| value.get("link"))
        .or_else(|| metadata.and_then(|m| m.get("sourceURL")))
        .or_else(|| metadata.and_then(|m| m.get("url")))
        .or_else(|| value.get("original"))
        .or_else(|| value.get("thumbnail"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let snippet = value
        .get("snippet")
        .or_else(|| value.get("content"))
        .or_else(|| value.get("description"))
        .or_else(|| metadata.and_then(|m| m.get("description")))
        .or_else(|| value.get("summary"))
        .or_else(|| value.get("markdown"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    WebSearchItem {
        title,
        url,
        snippet,
    }
}

fn extract_web_items(value: &Value, keys: &[&str]) -> Vec<Value> {
    for key in keys {
        let Some(candidate) = value.get(*key) else {
            continue;
        };
        if let Some(items) = candidate.as_array() {
            return items.clone();
        }
        if let Some(items) = extract_nested_web_items(candidate) {
            return items;
        }
    }
    Vec::new()
}

fn extract_nested_web_items(value: &Value) -> Option<Vec<Value>> {
    let object = value.as_object()?;
    for key in ["web", "results", "items"] {
        if let Some(items) = object.get(key).and_then(Value::as_array) {
            return Some(items.clone());
        }
    }
    None
}

fn required_api_key<'a>(config: &'a WebSearchConfig, provider: &str) -> Result<&'a str, String> {
    let key = config.api_key.trim();
    if key.is_empty() {
        Err(format!(
            "{provider} web.search requires an API key in Settings."
        ))
    } else {
        Ok(key)
    }
}

fn normalize_searxng_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("SearXNG URL is required".to_string());
    }
    let mut url = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    if !url.ends_with("/search") {
        url.push_str("/search");
    }
    Ok(url)
}

fn friendly_firecrawl_error(error: &str) -> String {
    if error
        .to_ascii_lowercase()
        .contains("ip address looks suspicious")
    {
        "Firecrawl Search rejected this IP for key-free access. Add a Firecrawl API key when that backend supports authenticated search, or choose another Web Search provider.".to_string()
    } else {
        format!("Firecrawl search failed: {error}")
    }
}

#[derive(Debug)]
struct KnowledgePage {
    path: String,
    title: String,
    stem: String,
    tags: Vec<String>,
    links: Vec<String>,
    matches_query: bool,
    neighbors: Vec<String>,
}

/// Build one bounded graph/provenance index for a complete retrieval tool
/// invocation. Never call this once per result: large projects would otherwise
/// turn top-k retrieval into top-k full filesystem scans.
fn build_knowledge_context_index(project_path: &str) -> BTreeMap<String, AgentKnowledgeContext> {
    build_knowledge_graph_snapshot(project_path, None).1
}

fn build_knowledge_graph_snapshot(
    project_path: &str,
    query: Option<&str>,
) -> (Vec<KnowledgePage>, BTreeMap<String, AgentKnowledgeContext>) {
    let wiki_root = Path::new(project_path).join("wiki");
    if !wiki_root.is_dir() {
        return (Vec::new(), BTreeMap::new());
    }

    let mut pages = Vec::new();
    for entry in WalkDir::new(&wiki_root).into_iter().filter_map(Result::ok) {
        if pages.len() >= MAX_GRAPH_SEARCH_FILES
            || !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let path = relative_to_project(project_path, entry.path());
        if is_hidden_rel(&path) {
            continue;
        }
        let title = search::extract_title(&content, entry.file_name().to_string_lossy().as_ref());
        let matches_query = query.is_some_and(|query| {
            let haystack = format!("{title} {path} {content}").to_lowercase();
            haystack.contains(query)
                || graph_query_terms(query)
                    .iter()
                    .any(|term| haystack.contains(term))
        });
        pages.push(KnowledgePage {
            path,
            title,
            stem: entry
                .path()
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            tags: extract_frontmatter_list(&content, "tags"),
            links: extract_wikilinks(&content),
            matches_query,
            neighbors: Vec::new(),
        });
    }

    let mut aliases: BTreeMap<String, String> = BTreeMap::new();
    for page in &pages {
        let wiki_relative_path = page.path.strip_prefix("wiki/").unwrap_or(&page.path);
        for alias in [&page.stem, &page.title, &page.path, wiki_relative_path] {
            aliases.insert(normalize_wiki_link(alias), page.path.clone());
        }
    }

    let mut backlinks: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut neighbors: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for page in &pages {
        for link in &page.links {
            if let Some(target) = aliases.get(&normalize_wiki_link(link)) {
                if target != &page.path {
                    backlinks
                        .entry(target.clone())
                        .or_default()
                        .insert(page.path.clone());
                    neighbors
                        .entry(page.path.clone())
                        .or_default()
                        .insert(target.clone());
                    neighbors
                        .entry(target.clone())
                        .or_default()
                        .insert(page.path.clone());
                }
            }
        }
    }

    for page in &mut pages {
        page.neighbors = neighbors
            .remove(&page.path)
            .unwrap_or_default()
            .into_iter()
            .take(MAX_KNOWLEDGE_CONTEXT_ITEMS)
            .collect();
    }

    let contexts = pages
        .iter()
        .map(|page| {
            let mut outgoing_links = page.links.clone();
            outgoing_links.sort();
            outgoing_links.dedup();
            let total_outgoing = outgoing_links.len();
            outgoing_links.truncate(MAX_KNOWLEDGE_CONTEXT_ITEMS);
            let mut page_backlinks: Vec<String> = backlinks
                .remove(&page.path)
                .unwrap_or_default()
                .into_iter()
                .collect();
            let total_backlinks = page_backlinks.len();
            page_backlinks.truncate(MAX_KNOWLEDGE_CONTEXT_ITEMS);
            let link_count = total_outgoing + total_backlinks;
            (
                page.path.clone(),
                AgentKnowledgeContext {
                    related_to: Vec::new(),
                    tags: page
                        .tags
                        .iter()
                        .cloned()
                        .take(MAX_KNOWLEDGE_CONTEXT_ITEMS)
                        .collect(),
                    outgoing_links,
                    backlinks: page_backlinks,
                    link_count,
                    latest_version: None,
                },
            )
        })
        .collect();
    (pages, contexts)
}

fn attach_latest_version(
    project_path: &str,
    relative_path: &str,
    context: &mut Option<AgentKnowledgeContext>,
) {
    let Some(context) = context else {
        return;
    };
    context.latest_version = crate::commands::file_history::latest_file_version(
        &Path::new(project_path).join(relative_path),
    )
    .map(|(timestamp, author, tool)| AgentVersionSummary {
        timestamp,
        author,
        tool,
    });
}

fn normalize_wiki_link(value: &str) -> String {
    value
        .split('#')
        .next()
        .unwrap_or_default()
        .trim()
        .trim_end_matches(".md")
        .replace('\\', "/")
        .to_lowercase()
        .replace(' ', "-")
}

fn graph_query_terms(query: &str) -> Vec<String> {
    query
        .split(|character: char| {
            character.is_whitespace()
                || matches!(character, ',' | '，' | ';' | '；' | ':' | '：' | '/' | '|')
        })
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect()
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else {
            break;
        };
        let target = rest[..end].split('|').next().unwrap_or_default().trim();
        if !target.is_empty() {
            links.push(target.to_string());
        }
        rest = &rest[end + 2..];
    }
    links
}

fn extract_frontmatter_list(content: &str, key: &str) -> Vec<String> {
    let normalized = content.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return Vec::new();
    };
    let Some(end) = rest.find("\n---") else {
        return Vec::new();
    };
    let prefix = format!("{key}:");
    let lines: Vec<&str> = rest[..end].lines().collect();
    for (index, line) in lines.iter().enumerate() {
        let Some(value) = line.trim().strip_prefix(&prefix) else {
            continue;
        };
        let inline = value.trim();
        if inline.starts_with('[') && inline.ends_with(']') {
            return inline[1..inline.len() - 1]
                .split(',')
                .map(|item| item.trim().trim_matches(['\'', '"']).to_string())
                .filter(|item| !item.is_empty())
                .collect();
        }
        let mut values = Vec::new();
        for next in lines.iter().skip(index + 1) {
            let trimmed = next.trim();
            let Some(item) = trimmed.strip_prefix('-') else {
                break;
            };
            let item = item.trim().trim_matches(['\'', '"']);
            if !item.is_empty() {
                values.push(item.to_string());
            }
        }
        return values;
    }
    Vec::new()
}

/// Read a wiki markdown page, optionally paginated by 1-indexed line
/// range. Returns `WikiReadOutput` whose `content` is the file body
/// prefixed with `   N\t` line numbers (cat -n style) so subsequent
/// `wiki.edit_page` calls can quote exact substrings including
/// whitespace. `offset` defaults to 1 (start of file); `limit`
/// defaults to 200 lines, which is roughly the 6 KB activity-feed cap
/// once line numbers are baked in.
pub fn read_wiki_page(
    project_path: &str,
    rel_path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<WikiReadOutput, String> {
    let rel = normalize_rel_path(rel_path);
    if !is_public_read_rel(&rel) || !rel.to_ascii_lowercase().starts_with("wiki/") {
        return Err("wiki.read_page path must stay under wiki/".to_string());
    }
    let path = safe_project_join(project_path, &rel)?;
    let meta = fs::metadata(&path).map_err(|err| format!("Failed to read page metadata: {err}"))?;
    if !meta.is_file() {
        return Err("wiki.read_page path is not a file".to_string());
    }
    if meta.len() as usize > MAX_READ_PAGE_BYTES {
        return Err("wiki.read_page file is too large (hard cap)".to_string());
    }
    let raw = fs::read_to_string(&path).map_err(|err| format!("Failed to read wiki page: {err}"))?;
    let (start_line, end_line, body) = number_lines(&raw, offset, limit);
    Ok(WikiReadOutput {
        path: rel,
        content: body,
        start_line,
        end_line,
        total_lines: raw.split('\n').count(),
    })
}

/// Read a file from agent-workspace. Mirrors `read_wiki_page`
/// semantics (1-indexed offset/limit, cat -n line numbers) but
/// enforces the workspace-write path constraints so the agent cannot
/// read outside `agent-workspace/`, symlinks, or `wiki/` / `raw/`.
pub fn read_workspace_file(
    project_path: &str,
    rel_path: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<WikiReadOutput, String> {
    let (rel, path) =
        resolve_workspace_read_target(project_path, rel_path, "workspace.read_file")?;
    let meta = fs::metadata(&path).map_err(|err| format!("Failed to read file metadata: {err}"))?;
    if !meta.is_file() {
        return Err("workspace.read_file path is not a file".to_string());
    }
    if meta.len() as usize > MAX_WORKSPACE_WRITE_BYTES {
        return Err("workspace.read_file file is too large (hard cap)".to_string());
    }
    let raw = fs::read_to_string(&path).map_err(|err| format!("Failed to read file: {err}"))?;
    let (start_line, end_line, body) = number_lines(&raw, offset, limit);
    Ok(WikiReadOutput {
        path: format!("{AGENT_WORKSPACE_DIR}/{rel}"),
        content: body,
        start_line,
        end_line,
        total_lines: raw.split('\n').count(),
    })
}

/// Apply a targeted string replacement to a wiki markdown page
/// (ClaudeCode Edit semantics). `old_string` must appear at least
/// once; with `replace_all=false` (default), exactly one match is
/// required. On success the file is rewritten atomically and an
/// undo version is recorded via `record_file_version`.
pub(crate) fn edit_wiki_page_with_activity(
    project_path: &str,
    rel_path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<WikiEditOutput, String> {
    if old_string.is_empty() {
        return Err("wiki.edit_page old_string must not be empty".to_string());
    }
    let rel = normalize_wiki_write_path(rel_path)?;
    let path = safe_project_join(project_path, &rel)?;
    if !path.is_file() {
        return Err(format!("wiki.edit_page target does not exist: {rel}"));
    }
    let original = fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read wiki page for edit: {err}"))?;
    let matches = original.matches(old_string).count();
    if matches == 0 {
        return Err(format!(
            "wiki.edit_page old_string not found in {rel} — check whitespace and exact text"
        ));
    }
    if matches > 1 && !replace_all {
        return Err(format!(
            "wiki.edit_page old_string matches {matches} non-unique locations in {rel}; pass replace_all=true to batch-replace, or supply more surrounding context to make the old_string unique"
        ));
    }
    let updated = if replace_all {
        original.replace(old_string, new_string)
    } else {
        original.replacen(old_string, new_string, 1)
    };
    if updated.len() > MAX_WRITE_PAGE_BYTES {
        return Err("wiki.edit_page would exceed wiki page size cap".to_string());
    }
    let previous_content = workspace_rollback_snapshot(&path);
    crate::commands::file_history::record_file_version(
        &path,
        "baseline",
        "before.wiki.edit_page",
    );
    fs::write(&path, &updated)
        .map_err(|err| format!("Failed to write wiki page after edit: {err}"))?;
    crate::commands::file_history::record_file_version(&path, "agent", "wiki.edit_page");
    Ok(WikiEditOutput {
        reference: AgentReference {
            title: extract_markdown_title(&updated).unwrap_or_else(|| {
                Path::new(&rel)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Wiki page")
                    .replace('-', " ")
            }),
            path: rel.clone(),
            kind: "wiki".to_string(),
            snippet: Some(trim_text(&collapse_markdown_preview(&updated), 500))
                .filter(|value| !value.trim().is_empty()),
            score: None,
            knowledge_context: None,
        },
        previous_content,
        replacements: matches,
    })
}

/// Apply a targeted string replacement to a file in agent-workspace
/// (ClaudeCode Edit semantics for workspace files). Same uniqueness
/// rules and Undo recording as `edit_wiki_page_with_activity`.
pub(crate) fn edit_workspace_file_with_activity(
    project_path: &str,
    rel_path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<WorkspaceEditOutput, String> {
    if old_string.is_empty() {
        return Err("workspace.edit_file old_string must not be empty".to_string());
    }
    let (rel, path) =
        resolve_workspace_write_target(project_path, rel_path, "workspace.edit_file")?;
    if path
        .symlink_metadata()
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("workspace.edit_file refuses to overwrite a symlink".to_string());
    }
    if !path.is_file() {
        return Err(format!("workspace.edit_file target does not exist: {rel}"));
    }
    let original = fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read workspace file for edit: {err}"))?;
    let matches = original.matches(old_string).count();
    if matches == 0 {
        return Err(format!(
            "workspace.edit_file old_string not found in {rel} — check whitespace and exact text"
        ));
    }
    if matches > 1 && !replace_all {
        return Err(format!(
            "workspace.edit_file old_string matches {matches} non-unique locations in {rel}; pass replace_all=true to batch-replace, or supply more surrounding context to make the old_string unique"
        ));
    }
    let updated = if replace_all {
        original.replace(old_string, new_string)
    } else {
        original.replacen(old_string, new_string, 1)
    };
    if updated.len() > MAX_WORKSPACE_WRITE_BYTES {
        return Err("workspace.edit_file would exceed workspace size cap".to_string());
    }
    let existed_before = true;
    let previous_content = workspace_rollback_snapshot(&path);
    crate::commands::file_history::record_file_version(
        &path,
        "baseline",
        "before.workspace.edit_file",
    );
    fs::write(&path, &updated)
        .map_err(|err| format!("workspace.edit_file failed: {err}"))?;
    crate::commands::file_history::record_file_version(&path, "agent", "workspace.edit_file");
    Ok(WorkspaceEditOutput {
        path: format!("{AGENT_WORKSPACE_DIR}/{rel}"),
        bytes: updated.len(),
        existed_before,
        previous_content,
        replacements: matches,
    })
}

/// Output of `workspace.edit_file`. Mirrors `WorkspaceWriteOutput`
/// (path / bytes / existed_before / rollback snapshot) plus the
/// replacement count for verification.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEditOutput {
    pub path: String,
    pub bytes: usize,
    #[serde(default)]
    pub existed_before: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_content: Option<String>,
    pub replacements: usize,
}

/// Format a string slice as `   N\t<line>` lines and return the
/// `(start_line, end_line, body)` triple for `WikiReadOutput`. Shared
/// by `read_wiki_page` and `read_workspace_file` so the cat -n
/// format is identical across both tools. Default slice size is 200
/// lines — keeps the body under ~6 KB once line-number prefixes
/// are added, matching the activity-feed `trim_chars` cap.
fn number_lines(raw: &str, offset: Option<usize>, limit: Option<usize>) -> (usize, usize, String) {
    let lines: Vec<&str> = raw.split('\n').collect();
    let total = lines.len();
    if total == 0 {
        return (1, 1, String::new());
    }
    // 1-indexed: offset=3 means start at line 3 inclusive.
    let start_idx = offset.unwrap_or(1).saturating_sub(1).min(total - 1);
    let default_take = 200usize.min(total - start_idx);
    let take = limit.unwrap_or(default_take);
    let end_idx = (start_idx + take).min(total);
    let body = lines[start_idx..end_idx]
        .iter()
        .enumerate()
        .map(|(idx, line)| format!("{:>5}\t{}", start_idx + idx + 1, line))
        .collect::<Vec<_>>()
        .join("\n");
    (start_idx + 1, end_idx, body)
}

pub fn search_graph(
    project_path: &str,
    query: &str,
    top_k: usize,
) -> Result<Vec<AgentReference>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let (pages, mut context_index) = build_knowledge_graph_snapshot(project_path, Some(&query));
    let seed_paths: BTreeSet<String> = pages
        .iter()
        .filter(|page| page.matches_query)
        .map(|page| page.path.clone())
        .collect();
    if seed_paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut refs = Vec::new();
    for page in pages {
        let Some(page_context) = context_index.get(&page.path) else {
            continue;
        };
        let link_count = page_context.link_count;
        let connected_to_seed = page
            .neighbors
            .iter()
            .any(|neighbor| seed_paths.contains(neighbor));
        if !page.matches_query && !connected_to_seed {
            continue;
        }
        let rel = page.path;
        let relation = if page.matches_query {
            "matched entity"
        } else {
            "direct neighbor"
        };
        refs.push(AgentReference {
            title: page.title,
            path: rel.clone(),
            kind: "graph".to_string(),
            snippet: Some(format!("{relation}; {link_count} related link(s)")),
            score: Some(
                if page.matches_query {
                    10_000.0
                } else {
                    5_000.0
                } + link_count as f64,
            ),
            knowledge_context: {
                let mut context = context_index.remove(&rel);
                attach_latest_version(project_path, &rel, &mut context);
                context
            },
        });
    }
    refs.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
    refs.truncate(top_k.clamp(1, 10));
    Ok(refs)
}

pub fn search_sources(
    project_path: &str,
    query: &str,
    top_k: usize,
) -> Result<Vec<AgentReference>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("source.search query is required".to_string());
    }
    let root = Path::new(project_path).join("raw").join("sources");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let lower_query = query.to_lowercase();
    let query_terms = source_query_terms(&lower_query);
    let mut refs = Vec::new();
    let mut seen_files = 0usize;
    for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        seen_files += 1;
        if seen_files > MAX_SOURCE_SEARCH_FILES {
            eprintln!(
                "[Agent] source.search stopped after {MAX_SOURCE_SEARCH_FILES} files in {project_path}"
            );
            break;
        }
        let Some(ext) = entry
            .path()
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
        else {
            continue;
        };
        if !matches!(
            ext.as_str(),
            "md" | "markdown" | "txt" | "json" | "csv" | "tsv" | "yaml" | "yml" | "xml" | "html"
        ) {
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let lower = content.to_lowercase();
        let matched = std::iter::once(lower_query.as_str())
            .chain(query_terms.iter().map(String::as_str))
            .find_map(|term| lower.find(term).map(|idx| (idx, term.len())));
        let Some((byte_idx, _matched_len)) = matched else {
            continue;
        };
        let rel = relative_to_project(project_path, entry.path());
        if is_hidden_rel(&rel) {
            continue;
        }
        refs.push(AgentReference {
            title: entry
                .path()
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&rel)
                .to_string(),
            path: rel,
            kind: "source".to_string(),
            snippet: Some(snippet_around_byte(
                &content,
                byte_idx,
                MAX_SOURCE_SNIPPET_CHARS,
            )),
            score: None,
            knowledge_context: None,
        });
        if refs.len() >= top_k.clamp(1, 10) {
            break;
        }
    }
    Ok(refs)
}

fn source_query_terms(query: &str) -> Vec<String> {
    query
        .split(|c: char| c.is_whitespace() || matches!(c, ',' | '，' | ';' | '；' | ':' | '：'))
        .map(str::trim)
        .filter(|term| term.chars().count() >= 2)
        .filter(|term| {
            !matches!(
                *term,
                "raw"
                    | "source"
                    | "sources"
                    | "file"
                    | "files"
                    | "原始资料"
                    | "原始文件"
                    | "源文件"
            )
        })
        .map(ToString::to_string)
        .collect()
}

fn safe_project_join(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_path);
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("path must be project-relative".to_string());
    }
    let joined = root.join(rel_path);
    if joined.exists() {
        let root_canon = root
            .canonicalize()
            .map_err(|err| format!("Failed to resolve project path: {err}"))?;
        let joined_canon = joined
            .canonicalize()
            .map_err(|err| format!("Failed to resolve requested path: {err}"))?;
        if !joined_canon.starts_with(root_canon) {
            return Err("path escapes project directory".to_string());
        }
    }
    Ok(joined)
}

fn ensure_existing_ancestor_bound(project_path: &str, path: &Path) -> Result<(), String> {
    let mut cursor = path;
    while !cursor.exists() {
        cursor = cursor
            .parent()
            .ok_or_else(|| "path must have an existing project ancestor".to_string())?;
    }
    ensure_project_bound_path(project_path, cursor)
}

fn ensure_project_bound_path(project_path: &str, path: &Path) -> Result<(), String> {
    let root_canon = Path::new(project_path)
        .canonicalize()
        .map_err(|err| format!("Failed to resolve project path: {err}"))?;
    let path_canon = path
        .canonicalize()
        .map_err(|err| format!("Failed to resolve requested path: {err}"))?;
    if !path_canon.starts_with(root_canon) {
        return Err("path escapes project directory".to_string());
    }
    Ok(())
}

fn is_public_read_rel(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    if lower.split('/').any(|segment| segment.starts_with('.')) {
        return false;
    }
    lower == "purpose.md"
        || lower == "schema.md"
        || lower.starts_with("wiki/")
        || lower.starts_with("raw/sources/")
}

fn is_hidden_rel(rel: &str) -> bool {
    normalize_rel_path(rel)
        .split('/')
        .any(|segment| segment.starts_with('.'))
}

fn normalize_rel_path(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string()
}

fn normalize_wiki_write_path(path: &str) -> Result<String, String> {
    let rel = normalize_rel_path(path);
    let lower = rel.to_ascii_lowercase();
    if !lower.starts_with("wiki/") || !lower.ends_with(".md") {
        return Err("wiki.write_page path must be a Markdown file under wiki/".to_string());
    }
    if lower.split('/').any(|segment| segment.starts_with('.')) {
        return Err("wiki.write_page cannot write hidden paths".to_string());
    }
    let rel_path = Path::new(&rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("wiki.write_page path must stay inside the project".to_string());
    }
    for segment in rel.split('/') {
        validate_portable_path_segment(segment)?;
    }
    Ok(rel)
}

fn normalize_workspace_write_path(path: &str) -> Result<String, String> {
    let rel = normalize_rel_path(path);
    let lower = rel.to_ascii_lowercase();
    if rel.is_empty()
        || lower.starts_with("wiki/")
        || lower.starts_with("raw/")
        || lower.split('/').any(|segment| segment.starts_with('.'))
    {
        return Err(
            "workspace.write_file path must be a relative file under agent-workspace".to_string(),
        );
    }
    let rel_path = Path::new(&rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("workspace.write_file path must stay inside agent-workspace".to_string());
    }
    for segment in rel.split('/') {
        validate_workspace_path_segment(segment)?;
    }
    Ok(rel)
}

fn validate_workspace_path_segment(segment: &str) -> Result<(), String> {
    validate_portable_path_segment(segment)
        .map_err(|err| err.replace("wiki.write_page", "workspace.write_file"))
}

fn validate_portable_path_segment(segment: &str) -> Result<(), String> {
    if segment.is_empty() {
        return Err("wiki.write_page path contains an empty segment".to_string());
    }
    if segment.ends_with([' ', '.']) {
        return Err(
            "wiki.write_page path contains a segment ending with a space or dot, which is not portable to Windows"
                .to_string(),
        );
    }
    if segment
        .chars()
        .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') || ch <= '\u{1f}')
    {
        return Err(
            "wiki.write_page path contains characters that are invalid on Windows".to_string(),
        );
    }
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err("wiki.write_page path uses a Windows reserved device name".to_string());
    }
    Ok(())
}

fn extract_markdown_title(content: &str) -> Option<String> {
    for line in content.lines().take(80) {
        let trimmed = line.trim();
        if let Some(title) = trimmed.strip_prefix("title:") {
            let title = title.trim().trim_matches('"').trim_matches('\'');
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
        if let Some(heading) = trimmed.strip_prefix("# ") {
            let heading = heading.trim();
            if !heading.is_empty() {
                return Some(heading.to_string());
            }
        }
    }
    None
}

fn collapse_markdown_preview(content: &str) -> String {
    content
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && trimmed != "---" && !trimmed.starts_with("title:")
        })
        .take(12)
        .collect::<Vec<_>>()
        .join(" ")
}

fn relative_to_project(project_path: &str, path: &Path) -> String {
    path.strip_prefix(project_path)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string()
}

fn snippet_around_byte(content: &str, byte_idx: usize, max_chars: usize) -> String {
    let char_idx = content[..byte_idx.min(content.len())].chars().count();
    let start = char_idx.saturating_sub(max_chars / 2);
    let mut snippet = content
        .chars()
        .skip(start)
        .take(max_chars)
        .collect::<String>();
    if start > 0 {
        snippet.insert_str(0, "...");
    }
    if content.chars().count() > start + max_chars {
        snippet.push_str("...");
    }
    snippet.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn trim_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_string()
    } else {
        format!("{}...", value.chars().take(max_chars).collect::<String>())
    }
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            b' ' => vec!['+'],
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use uuid::Uuid;

    use super::*;

    /// Per-test scratch directory under std::env::temp_dir(); the project
    /// path doesn't need to exist on disk for path-validation tests, but
    /// the wiki subdirectory is materialised where tests write files.
    fn fresh_project_dir(label: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = env::temp_dir().join(format!(
            "llm-wiki-tools-{label}-{}-{}",
            std::process::id(),
            n
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn builtin_tool_specs_include_expected_tools() {
        let names = builtin_tool_specs()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"wiki.search".to_string()));
        assert!(names.contains(&"wiki.read_page".to_string()));
        assert!(names.contains(&"wiki.write_page".to_string()));
        assert!(names.contains(&"wiki.edit_page".to_string()));
        assert!(names.contains(&"source.search".to_string()));
        assert!(names.contains(&"graph.search".to_string()));
        assert!(names.contains(&"anytxt.search".to_string()));
        assert!(names.contains(&"llm.generate".to_string()));
        assert!(names.contains(&"skills.load".to_string()));
        assert!(names.contains(&"skill.read_file".to_string()));
        assert!(names.contains(&"workspace.write_file".to_string()));
        assert!(names.contains(&"workspace.append_file".to_string()));
        assert!(names.contains(&"workspace.read_file".to_string()));
        assert!(names.contains(&"workspace.edit_file".to_string()));
        assert!(names.contains(&"shell.exec".to_string()));
    }

    #[test]
    fn wiki_edit_page_unique_match_replaces_once() {
        let dir = fresh_project_dir("edit-unique");
        let wiki_dir = dir.join("wiki");
        fs::create_dir_all(&wiki_dir).unwrap();
        let path = wiki_dir.join("notes.md");
        fs::write(&path, "alpha\nbeta\ngamma\ndelta\n").unwrap();
        let output =
            edit_wiki_page_with_activity(dir.to_str().unwrap(), "wiki/notes.md", "beta", "BETA", false).unwrap();
        assert_eq!(output.replacements, 1);
        let updated = fs::read_to_string(&path).unwrap();
        assert_eq!(updated, "alpha\nBETA\ngamma\ndelta\n");
    }

    #[test]
    fn wiki_edit_page_ambiguous_match_rejected_without_replace_all() {
        let dir = fresh_project_dir("edit-ambiguous");
        let wiki_dir = dir.join("wiki");
        fs::create_dir_all(&wiki_dir).unwrap();
        fs::write(wiki_dir.join("dup.md"), "x\nx\n").unwrap();
        let err = edit_wiki_page_with_activity(
            dir.to_str().unwrap(),
            "wiki/dup.md",
            "x",
            "y",
            false,
        )
        .unwrap_err();
        assert!(err.contains("non-unique"), "err was: {err}");
    }

    #[test]
    fn wiki_edit_page_replace_all_batch_replaces() {
        let dir = fresh_project_dir("edit-replace-all");
        let wiki_dir = dir.join("wiki");
        fs::create_dir_all(&wiki_dir).unwrap();
        fs::write(wiki_dir.join("multi.md"), "x\nx\nx\n").unwrap();
        let output = edit_wiki_page_with_activity(
            dir.to_str().unwrap(),
            "wiki/multi.md",
            "x",
            "y",
            true,
        )
        .unwrap();
        assert_eq!(output.replacements, 3);
        assert_eq!(fs::read_to_string(wiki_dir.join("multi.md")).unwrap(), "y\ny\ny\n");
    }

    #[test]
    fn wiki_edit_page_empty_old_string_rejected() {
        let dir = fresh_project_dir("edit-empty");
        let wiki_dir = dir.join("wiki");
        fs::create_dir_all(&wiki_dir).unwrap();
        fs::write(wiki_dir.join("x.md"), "anything").unwrap();
        let err = edit_wiki_page_with_activity(
            dir.to_str().unwrap(),
            "wiki/x.md",
            "",
            "new",
            false,
        )
        .unwrap_err();
        assert!(err.contains("must not be empty"), "err was: {err}");
    }

    #[test]
    fn wiki_edit_page_missing_target_rejected() {
        let dir = fresh_project_dir("edit-missing");
        let wiki_dir = dir.join("wiki");
        fs::create_dir_all(&wiki_dir).unwrap();
        let err = edit_wiki_page_with_activity(
            dir.to_str().unwrap(),
            "wiki/missing.md",
            "x",
            "y",
            false,
        )
        .unwrap_err();
        assert!(err.contains("does not exist"), "err was: {err}");
    }

    #[test]
    fn wiki_read_page_offset_limit_returns_line_numbered_slice() {
        let dir = fresh_project_dir("read-offset");
        let wiki_dir = dir.join("wiki");
        fs::create_dir_all(&wiki_dir).unwrap();
        fs::write(wiki_dir.join("p.md"), "a\nb\nc\nd\ne\n").unwrap();
        let output =
            read_wiki_page(dir.to_str().unwrap(), "wiki/p.md", Some(2), Some(2)).unwrap();
        assert_eq!(output.start_line, 2);
        assert_eq!(output.end_line, 3);
        // Trailing newline makes split('\n') produce 6 elements (a, b, c, d, e, "").
        assert_eq!(output.total_lines, 6);
        assert!(output.content.starts_with("    2\tb"), "content was: {:?}", output.content);
        assert!(output.content.contains("    3\tc"));
        assert!(!output.content.contains("    4\td"), "should not include line 4 with limit=2");
    }

    #[test]
    fn workspace_read_file_rejects_path_outside_workspace() {
        let dir = fresh_project_dir("ws-read-escape");
        // workspace path validation rejects ../ traversal
        let err = read_workspace_file(
            dir.to_str().unwrap(),
            "../escape.txt",
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("workspace"), "err was: {err}");
    }

    #[test]
    fn read_wiki_page_rejects_traversal() {
        let err = read_wiki_page("/tmp/project", "../secret.md", None, None).unwrap_err();
        assert!(err.contains("wiki.read_page"));
    }

    #[test]
    fn knowledge_context_indexes_tags_links_backlinks_and_latest_version() {
        let root = std::env::temp_dir().join(format!("llm-wiki-context-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki/entities")).unwrap();
        let alpha = root.join("wiki/entities/alpha.md");
        let beta = root.join("wiki/entities/beta.md");
        fs::write(
            &alpha,
            "---\r\ntitle: Alpha\r\ntags: [core, test]\r\n---\r\n# Alpha\r\n\r\n[[Beta]]",
        )
        .unwrap();
        fs::write(
            &beta,
            "---\ntitle: Beta\ntags:\n  - linked\n---\n# Beta\n\n[[entities/alpha]]",
        )
        .unwrap();
        crate::commands::file_history::record_file_version(&alpha, "agent", "test.write");

        let mut contexts = build_knowledge_context_index(root.to_str().unwrap());
        let mut alpha_context = contexts.remove("wiki/entities/alpha.md");
        attach_latest_version(
            root.to_str().unwrap(),
            "wiki/entities/alpha.md",
            &mut alpha_context,
        );
        let alpha_context = alpha_context.as_ref().unwrap();
        let beta_context = contexts.get("wiki/entities/beta.md").unwrap();

        assert_eq!(alpha_context.tags, vec!["core", "test"]);
        assert_eq!(alpha_context.outgoing_links, vec!["Beta"]);
        assert_eq!(alpha_context.backlinks, vec!["wiki/entities/beta.md"]);
        assert_eq!(alpha_context.link_count, 2);
        assert_eq!(
            alpha_context.latest_version.as_ref().unwrap().tool,
            "test.write"
        );
        assert_eq!(beta_context.tags, vec!["linked"]);
        assert_eq!(beta_context.backlinks, vec!["wiki/entities/alpha.md"]);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn registry_executes_declared_read_page_and_deep_tools() {
        let root = std::env::temp_dir().join(format!("llm-wiki-tool-registry-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki").join("concepts")).unwrap();
        fs::write(root.join("wiki/concepts/a.md"), "# A\n\nBody").unwrap();

        let registry = BuiltinToolRegistry;
        let context = ToolContext {
            project_path: root.to_str().unwrap(),
            project_id: "test-project",
            session_id: Some("test-session".to_string()),
            embedding_config: None,
            web_search_config: None,
            anytxt_config: None,
        };
        let read = registry
            .execute(
                "wiki.read_page",
                json!({ "path": "wiki/concepts/a.md" }),
                context.clone(),
            )
            .await
            .unwrap();
        assert_eq!(read["path"], "wiki/concepts/a.md");
        assert!(read["content"].as_str().unwrap().contains("Body"));

        let deep = registry
            .execute("deep_research.run", json!({ "query": "topic" }), context)
            .await
            .unwrap();
        assert_eq!(deep["status"], "orchestrated_by_agent_runtime");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn registry_executes_project_scoped_shell_command() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-tool-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let registry = BuiltinToolRegistry;
        let context = ToolContext {
            project_path: root.to_str().unwrap(),
            project_id: "test-project",
            session_id: Some("test-session".to_string()),
            embedding_config: None,
            web_search_config: None,
            anytxt_config: None,
        };
        let output = registry
            .execute(
                "shell.exec",
                json!({ "command": "echo skill-ok", "timeoutSeconds": 5 }),
                context,
            )
            .await
            .unwrap();
        assert!(output["stdout"].as_str().unwrap().contains("skill-ok"));
        assert_eq!(output["timedOut"], false);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shell_exec_timeout_returns_without_unbounded_wait() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-timeout-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        #[cfg(windows)]
        let command = "ping -n 6 127.0.0.1 > nul";
        #[cfg(not(windows))]
        let command = "sleep 5";
        let output = run_shell_exec(root.to_str().unwrap(), command, 1)
            .await
            .unwrap();
        assert!(output.timed_out);
        assert!(output.stderr.contains("timed out"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn shell_exec_does_not_wait_forever_for_background_pipe_holders() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-bg-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let output = timeout(
            Duration::from_secs(3),
            run_shell_exec(root.to_str().unwrap(), "sleep 5 &", 5),
        )
        .await
        .expect("shell.exec should not hang on background grandchildren")
        .unwrap();
        assert!(output.stdout.contains("output was still open"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn shell_exec_sanitizes_environment() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-env-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        std::env::set_var("LLM_WIKI_SECRET_TEST_SENTINEL", "must-not-leak");
        let output = run_shell_exec(root.to_str().unwrap(), "env", 5)
            .await
            .unwrap();
        std::env::remove_var("LLM_WIKI_SECRET_TEST_SENTINEL");
        assert!(output
            .stdout
            .contains(&format!("LLM_WIKI_PROJECT={}", root.to_string_lossy())));
        assert!(output.stdout.contains(&format!(
            "LLM_WIKI_AGENT_WORKSPACE={}",
            root.join(AGENT_WORKSPACE_DIR).to_string_lossy()
        )));
        assert!(!output.stdout.contains("LLM_WIKI_SECRET_TEST_SENTINEL="));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shell_exec_runs_from_visible_agent_workspace() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-shell-workspace-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        #[cfg(windows)]
        let command = "cd && echo hello>generated.txt";
        #[cfg(not(windows))]
        let command = "pwd && printf hello > generated.txt";

        let output = run_shell_exec(root.to_str().unwrap(), command, 5)
            .await
            .unwrap();
        let workspace = root.join(AGENT_WORKSPACE_DIR);

        assert!(workspace.is_dir());
        assert_eq!(
            fs::read_to_string(workspace.join("generated.txt"))
                .unwrap()
                .trim(),
            "hello"
        );
        assert!(!root.join("generated.txt").exists());
        assert!(output
            .stdout
            .replace('\\', "/")
            .contains(&workspace.to_string_lossy().replace('\\', "/")));
        assert!(output
            .generated_files
            .iter()
            .any(|file| file.path == "agent-workspace/generated.txt"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shell_exec_reports_changed_workspace_files() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-shell-generated-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        #[cfg(windows)]
        let command = "mkdir images && echo image>images\\cover.png";
        #[cfg(not(windows))]
        let command = "mkdir -p images && printf image > images/cover.png";

        let output = run_shell_exec(root.to_str().unwrap(), command, 5)
            .await
            .unwrap();

        assert!(output
            .generated_files
            .iter()
            .any(|file| { file.path == "agent-workspace/images/cover.png" && file.bytes > 0 }));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_exec_rejects_symlinked_agent_workspace_escape() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("llm-wiki-shell-workspace-link-{}", Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!(
            "llm-wiki-shell-workspace-outside-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join(AGENT_WORKSPACE_DIR)).unwrap();

        let err = run_shell_exec(root.to_str().unwrap(), "pwd", 5)
            .await
            .unwrap_err();

        assert!(err.contains("escapes project directory"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn changed_workspace_files_detects_same_size_rewrites() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-shell-same-size-{}", Uuid::new_v4()));
        let workspace = root.join(AGENT_WORKSPACE_DIR);
        fs::create_dir_all(&workspace).unwrap();
        let file = workspace.join("artifact.html");
        fs::write(&file, "before").unwrap();

        let before = snapshot_workspace_files(&workspace);
        fs::write(&file, "after!").unwrap();
        let changed = changed_workspace_files(&workspace, before);

        assert!(changed
            .iter()
            .any(|file| file.path == "agent-workspace/artifact.html"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_write_file_writes_only_visible_agent_workspace_files() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-workspace-write-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        let written =
            write_workspace_file(root.to_str().unwrap(), "cover-image/cover.svg", "<svg/>")
                .unwrap();
        assert_eq!(written.path, "agent-workspace/cover-image/cover.svg");
        assert!(!written.existed_before);
        assert_eq!(written.previous_content, None);
        assert_eq!(
            fs::read_to_string(root.join("agent-workspace/cover-image/cover.svg")).unwrap(),
            "<svg/>"
        );
        assert!(write_workspace_file(root.to_str().unwrap(), "../escape.txt", "x").is_err());
        assert!(write_workspace_file(root.to_str().unwrap(), "wiki/page.md", "x").is_err());
        assert!(write_workspace_file(root.to_str().unwrap(), ".hidden/file.txt", "x").is_err());
        assert!(write_workspace_file(root.to_str().unwrap(), "cover./file.txt", "x").is_err());
        assert!(write_workspace_file(root.to_str().unwrap(), "cover /file.txt", "x").is_err());
        assert!(write_workspace_file(
            root.to_str().unwrap(),
            "large.txt",
            &"x".repeat(MAX_WORKSPACE_WRITE_BYTES + 1)
        )
        .unwrap_err()
        .contains("too large"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_append_file_extends_visible_workspace_files() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-workspace-append-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        write_workspace_file(root.to_str().unwrap(), "ppt/index.html", "<html>").unwrap();
        let appended =
            append_workspace_file(root.to_str().unwrap(), "ppt/index.html", "</html>").unwrap();

        assert_eq!(appended.path, "agent-workspace/ppt/index.html");
        assert_eq!(appended.bytes, "<html></html>".len());
        assert!(appended.existed_before);
        assert_eq!(appended.previous_content.as_deref(), Some("<html>"));
        assert_eq!(
            fs::read_to_string(root.join("agent-workspace/ppt/index.html")).unwrap(),
            "<html></html>"
        );
        assert!(append_workspace_file(root.to_str().unwrap(), "../escape.txt", "x").is_err());
        assert!(append_workspace_file(root.to_str().unwrap(), ".hidden/file.txt", "x").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_write_file_rejects_target_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("llm-wiki-workspace-symlink-{}", Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("llm-wiki-workspace-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(AGENT_WORKSPACE_DIR)).unwrap();
        fs::write(&outside, "original").unwrap();
        symlink(&outside, root.join(AGENT_WORKSPACE_DIR).join("escape.txt")).unwrap();

        assert!(
            write_workspace_file(root.to_str().unwrap(), "escape.txt", "overwrite")
                .unwrap_err()
                .contains("symlink")
        );
        assert_eq!(fs::read_to_string(&outside).unwrap(), "original");
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn shell_exec_caps_large_output() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-cap-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let output = run_shell_exec(root.to_str().unwrap(), "printf '%050000d' 0", 5)
            .await
            .unwrap();
        assert!(output.stdout.chars().count() <= MAX_SHELL_OUTPUT_CHARS + 3);
        assert!(output.stdout.ends_with("..."));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn shell_exec_rejects_invalid_inputs() {
        let root = std::env::temp_dir().join(format!("llm-wiki-shell-invalid-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        assert!(run_shell_exec(root.to_str().unwrap(), "", 1)
            .await
            .unwrap_err()
            .contains("empty"));
        assert!(run_shell_exec(
            root.to_str().unwrap(),
            &"x".repeat(MAX_SHELL_COMMAND_CHARS + 1),
            1
        )
        .await
        .unwrap_err()
        .contains("too long"));
        let missing = root.join("missing");
        assert!(run_shell_exec(missing.to_str().unwrap(), "echo no", 1)
            .await
            .unwrap_err()
            .contains("not available"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn write_wiki_page_rejects_unsafe_paths_and_writes_markdown() {
        let root = std::env::temp_dir().join(format!("llm-wiki-agent-write-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki")).unwrap();

        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "../secret.md",
            "# Secret",
            false
        )
        .is_err());
        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "raw/sources/a.md",
            "# A",
            false
        )
        .is_err());
        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/.hidden/a.md",
            "# A",
            false
        )
        .is_err());
        assert!(
            write_wiki_page_with_options(root.to_str().unwrap(), "wiki/aux.md", "# A", false)
                .is_err()
        );
        assert!(
            write_wiki_page_with_options(root.to_str().unwrap(), "wiki/con.md", "# A", false)
                .is_err()
        );
        assert!(
            write_wiki_page_with_options(root.to_str().unwrap(), "wiki/a:b.md", "# A", false)
                .is_err()
        );
        assert!(
            write_wiki_page_with_options(root.to_str().unwrap(), "wiki/a?b.md", "# A", false)
                .is_err()
        );
        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/topic./a.md",
            "# A",
            false
        )
        .is_err());
        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/topic /a.md",
            "# A",
            false
        )
        .is_err());
        assert!(write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/queries/huge.md",
            &"x".repeat(MAX_WRITE_PAGE_BYTES + 1),
            false,
        )
        .is_err());

        let reference = write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/queries/new-page.md",
            "---\ntitle: New Page\n---\n# New Page\n\nBody",
            false,
        )
        .unwrap();
        assert_eq!(reference.title, "New Page");
        assert_eq!(reference.path, "wiki/queries/new-page.md");
        assert!(root.join("wiki/queries/new-page.md").exists());
        let overwrite_err = write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/queries/new-page.md",
            "# Replaced",
            false,
        )
        .unwrap_err();
        assert!(overwrite_err.contains("refuses to overwrite"));
        let overwritten = write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/queries/new-page.md",
            "# Replaced",
            true,
        )
        .unwrap();
        assert_eq!(overwritten.title, "Replaced");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn wiki_write_activity_captures_create_and_overwrite_state() {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-agent-write-activity-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki")).unwrap();

        let created = write_wiki_page_with_activity(
            root.to_str().unwrap(),
            "wiki/page.md",
            "# Original",
            false,
        )
        .unwrap();
        assert!(!created.existed_before);
        assert_eq!(created.previous_content, None);

        let modified = write_wiki_page_with_activity(
            root.to_str().unwrap(),
            "wiki/page.md",
            "# Updated",
            true,
        )
        .unwrap();
        assert!(modified.existed_before);
        assert_eq!(modified.previous_content.as_deref(), Some("# Original"));
        assert_eq!(modified.reference.path, "wiki/page.md");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn write_wiki_page_rejects_symlink_parent_escape_for_new_files() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("llm-wiki-agent-symlink-{}", Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("llm-wiki-agent-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("wiki").join("linked")).unwrap();

        let err = write_wiki_page_with_options(
            root.to_str().unwrap(),
            "wiki/linked/newsub/escape.md",
            "# Escape",
            false,
        )
        .unwrap_err();
        assert!(err.contains("escapes project directory"));
        assert!(!outside.join("newsub").exists());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn search_sources_returns_source_references() {
        let root = std::env::temp_dir().join(format!("llm-wiki-source-search-{}", Uuid::new_v4()));
        let source_dir = root.join("raw").join("sources");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("paper.txt"), "Coal mine safety case study.").unwrap();

        let refs = search_sources(root.to_str().unwrap(), "safety", 5).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].kind, "source");
        assert!(refs[0].snippet.as_deref().unwrap().contains("safety"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_and_graph_search_skip_hidden_paths() {
        let root = std::env::temp_dir().join(format!("llm-wiki-hidden-search-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("raw/sources/.cache")).unwrap();
        fs::create_dir_all(root.join("wiki/.hidden")).unwrap();
        fs::write(root.join("raw/sources/.cache/secret.txt"), "needle secret").unwrap();
        fs::write(
            root.join("wiki/.hidden/secret.md"),
            "# Secret\n\nneedle [[A]]",
        )
        .unwrap();

        assert!(search_sources(root.to_str().unwrap(), "needle", 5)
            .unwrap()
            .is_empty());
        assert!(search_graph(root.to_str().unwrap(), "needle", 5)
            .unwrap()
            .is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_sources_uses_keyword_terms_from_natural_language() {
        let root = std::env::temp_dir().join(format!("llm-wiki-source-search-{}", Uuid::new_v4()));
        let source_dir = root.join("raw").join("sources");
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join("煤矿.txt"), "煤矿安全治理 source details.").unwrap();

        let refs = search_sources(root.to_str().unwrap(), "原始资料 煤矿安全", 5).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].kind, "source");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_graph_returns_relationship_references() {
        let root = std::env::temp_dir().join(format!("llm-wiki-graph-search-{}", Uuid::new_v4()));
        let wiki_dir = root.join("wiki").join("concepts");
        fs::create_dir_all(&wiki_dir).unwrap();
        fs::write(
            wiki_dir.join("agent.md"),
            "---\ntitle: Agent Graph\n---\n# Agent Graph\n\nLinks to [[Tool Registry]] and [[Context Builder]].",
        )
        .unwrap();
        fs::write(
            wiki_dir.join("tool-registry.md"),
            "---\ntitle: Tool Registry\n---\n# Tool Registry\n\nTool definitions.",
        )
        .unwrap();
        fs::write(
            wiki_dir.join("context-builder.md"),
            "---\ntitle: Context Builder\n---\n# Context Builder\n\nContext assembly.",
        )
        .unwrap();
        fs::write(
            wiki_dir.join("unrelated.md"),
            "---\ntitle: Unrelated Hub\n---\n# Unrelated Hub\n\n[[Missing A]] [[Missing B]] [[Missing C]].",
        )
        .unwrap();

        let refs = search_graph(root.to_str().unwrap(), "Agent Graph", 5).unwrap();
        assert_eq!(refs.len(), 3);
        assert_eq!(refs[0].title, "Agent Graph");
        assert!(refs[0]
            .snippet
            .as_deref()
            .unwrap()
            .contains("matched entity"));
        assert!(refs
            .iter()
            .skip(1)
            .all(|reference| reference.kind == "graph"
                && reference
                    .snippet
                    .as_deref()
                    .unwrap()
                    .contains("direct neighbor")));
        assert!(refs
            .iter()
            .any(|reference| reference.title == "Tool Registry"));
        assert!(refs
            .iter()
            .any(|reference| reference.title == "Context Builder"));
        assert!(!refs
            .iter()
            .any(|reference| reference.title == "Unrelated Hub"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn searxng_url_normalizes_to_search_endpoint() {
        assert_eq!(
            normalize_searxng_url("search.example.com").unwrap(),
            "https://search.example.com/search"
        );
        assert_eq!(
            normalize_searxng_url("https://search.example.com/search").unwrap(),
            "https://search.example.com/search"
        );
    }

    #[test]
    fn friendly_firecrawl_error_explains_key_free_ip_rejection() {
        let msg = friendly_firecrawl_error("Unfortunately, your IP address looks suspicious");
        assert!(msg.contains("rejected this IP"));
    }

    #[test]
    fn run_web_search_drops_empty_url_results_before_mapping_references() {
        let refs = web_items_to_references(
            vec![
                WebSearchItem {
                    title: "Missing".to_string(),
                    url: String::new(),
                    snippet: "no url".to_string(),
                },
                WebSearchItem {
                    title: "Valid".to_string(),
                    url: "https://example.com".to_string(),
                    snippet: "ok".to_string(),
                },
            ],
            10,
        );
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].title, "Valid");
        assert_eq!(refs[0].path, "https://example.com");
    }

    #[test]
    fn web_references_apply_limit_before_empty_url_filter_like_legacy_ui() {
        let refs = web_items_to_references(
            vec![
                WebSearchItem {
                    title: "Missing".to_string(),
                    url: String::new(),
                    snippet: "no url".to_string(),
                },
                WebSearchItem {
                    title: "Valid".to_string(),
                    url: "https://example.com".to_string(),
                    snippet: "ok".to_string(),
                },
            ],
            1,
        );
        assert!(refs.is_empty());
    }

    #[test]
    fn brave_message_without_web_is_treated_as_error() {
        let value = json!({ "message": "invalid subscription token" });
        assert_eq!(
            provider_payload_error("Brave Search", &value),
            Some("Brave Search search failed: invalid subscription token".to_string())
        );
    }

    #[test]
    fn non_brave_message_does_not_mask_valid_provider_payloads() {
        let value = json!({ "message": "FYI" });
        assert_eq!(provider_payload_error("Tavily", &value), None);
    }

    #[test]
    fn web_result_normalization_accepts_firecrawl_nested_metadata() {
        let items = extract_web_items(
            &json!({
                "data": {
                    "web": [
                        {
                            "metadata": {
                                "title": "Nested",
                                "sourceURL": "https://example.com/nested",
                                "description": "from metadata"
                            }
                        }
                    ]
                }
            }),
            &["data", "results"],
        );
        let item = normalize_web_result(items.into_iter().next().unwrap());
        assert_eq!(item.title, "Nested");
        assert_eq!(item.url, "https://example.com/nested");
        assert_eq!(item.snippet, "from metadata");
    }

    #[test]
    fn url_encode_handles_unicode_terms() {
        assert_eq!(url_encode("煤矿 safety"), "%E7%85%A4%E7%9F%BF+safety");
    }

    #[test]
    fn web_search_config_resolves_active_provider_override() {
        let mut configs = BTreeMap::new();
        configs.insert(
            "searxng".to_string(),
            WebSearchProviderOverride {
                sear_xng_url: Some("https://search.example.com".to_string()),
                ..Default::default()
            },
        );
        let cfg = WebSearchConfig {
            provider: "searxng".to_string(),
            provider_configs: Some(configs),
            ..Default::default()
        }
        .resolved();

        assert_eq!(
            cfg.sear_xng_url.as_deref(),
            Some("https://search.example.com")
        );
    }

    #[test]
    fn extract_anytxt_items_accepts_common_result_shapes() {
        let value = json!({
            "result": {
                "items": [
                    { "path": "/docs/a.pdf", "title": "A", "snippet": "coal mine" }
                ]
            }
        });
        let items = extract_anytxt_items(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "A");
        assert_eq!(items[0].path, "/docs/a.pdf");
        assert_eq!(items[0].snippet, "coal mine");
    }

    #[test]
    fn extract_anytxt_items_accepts_nested_output_and_field_rows() {
        let value = json!({
            "result": {
                "output": {
                    "field": ["fid", "full_path", "title", "hitText"],
                    "items": [
                        ["42", "/docs/煤矿.pdf", "煤矿资料", "煤矿安全治理片段"]
                    ]
                }
            }
        });
        let items = extract_anytxt_items(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].fid, "42");
        assert_eq!(items[0].path, "/docs/煤矿.pdf");
        assert_eq!(items[0].title, "煤矿资料");
        assert_eq!(items[0].snippet, "煤矿安全治理片段");
    }

    #[test]
    fn extract_anytxt_items_keeps_fid_only_results_addressable() {
        let value = json!({
            "result": {
                "data": {
                    "results": [
                        { "fid": 99, "snippet": "fragment only" }
                    ]
                }
            }
        });
        let items = extract_anytxt_items(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].path, "anytxt://99");
        assert_eq!(items[0].snippet, "fragment only");
    }

    #[test]
    fn extract_anytxt_items_accepts_value_shapes() {
        let value = json!({
            "result": {
                "output": {
                    "value": [
                        { "path": "/docs/value.txt", "snippet": "from value" }
                    ]
                }
            }
        });
        let items = extract_anytxt_items(&value);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].path, "/docs/value.txt");
        assert_eq!(items[0].snippet, "from value");
    }
}
