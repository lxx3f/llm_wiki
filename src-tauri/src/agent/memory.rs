//! Project-scoped Memory Store.
//!
//! Memory is structured, user-confirmed knowledge the Agent can carry across
//! sessions in a single project. `project` scope is cross-session; `session`
//! scope lives only for the duration of one Rust `AgentSessionStore` session
//! and never enters the cross-session index.
//!
//! Only `status = accepted + active + not expired` entries participate in
//! Agent context. Proposals, rejected entries, archived entries, and entries
//! marked `schema_stale` are never injected into prompts.
//!
//! All persistence is per-project: every path resolves inside
//! `<project>/.llm-wiki/memory/`. IDs and session IDs are validated; sensitive
//! material (API keys, private keys, cookies, connection strings, full chat
//! transcripts, image payloads, absolute system paths) is rejected at the
//! proposal boundary with a structured error so the UI can surface a clear
//! message instead of silently dropping it.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::commands::file_sync;

const MEMORY_DIR: &str = ".llm-wiki/memory";
const MAX_TITLE_BYTES: usize = 200;
const MAX_CONTENT_BYTES: usize = 4 * 1024;
const MAX_PROJECT_MEMORIES: usize = 256;
const MAX_AUDIT_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_TTL_MS: i64 = 1000 * 60 * 60 * 24 * 180;

const SENSITIVE_PATTERNS: &[&str] = &[
    "sk-ant-",
    "sk-",
    "ghp_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "AIzaSy",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "Authorization: Bearer ",
    "Authorization: Basic ",
    "Set-Cookie: ",
    "session=",
    "password=",
    "passwd=",
    "secret=",
    "token=",
    "apikey=",
    "api_key=",
    "-----BEGIN CERTIFICATE-----",
    "ssh-rsa ",
    "ssh-ed25519 ",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    UserPreference,
    ProjectConvention,
    ConfirmedFact,
    Decision,
    OpenQuestion,
    SchemaNote,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    Project,
    Session,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryConfidence {
    UserConfirmed,
    EvidenceBacked,
    AgentSuggested,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryStatus {
    Proposed,
    Accepted,
    Rejected,
    Archived,
    SchemaStale,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemorySource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_paths: Option<Vec<String>>,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemory {
    pub id: String,
    pub revision: u32,
    pub project_id: String,
    pub kind: MemoryKind,
    pub status: MemoryStatus,
    pub scope: MemoryScope,
    pub title: String,
    pub content: String,
    pub source: MemorySource,
    pub confidence: MemoryConfidence,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_stale_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProposal {
    pub memory: ProjectMemory,
    pub created_at: i64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryIndex {
    pub updated_at: i64,
    pub active_count: usize,
    pub proposal_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchHit {
    pub memory: ProjectMemory,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRedaction {
    pub id: String,
    pub redacted_at: i64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuditEvent {
    Proposed { memory_id: String, scope: MemoryScope, actor: String, at: i64 },
    Accepted { memory_id: String, scope: MemoryScope, actor: String, at: i64 },
    Rejected { memory_id: String, scope: MemoryScope, actor: String, at: i64, reason: String },
    Archived { memory_id: String, scope: MemoryScope, actor: String, at: i64, reason: String },
    Redacted { memory_id: String, scope: MemoryScope, actor: String, at: i64, reason: String },
    Imported { memory_id: String, scope: MemoryScope, actor: String, at: i64, source: String },
    SchemaStale { memory_id: String, scope: MemoryScope, actor: String, at: i64, reason: String },
}

pub struct ProjectMemoryStore;

impl ProjectMemoryStore {
    pub fn create_proposal(
        project_path: &str,
        project_id: &str,
        session_id: Option<&str>,
        kind: MemoryKind,
        scope: MemoryScope,
        title: &str,
        content: &str,
        confidence: MemoryConfidence,
        reference_paths: Option<Vec<String>>,
        reason: &str,
    ) -> Result<MemoryProposal, String> {
        validate_title(title)?;
        validate_content(content)?;
        reject_sensitive(content)?;
        let project_root = canonical_project_root(project_path)?;
        enforce_size_limits(&project_root)?;
        let now = now_ms();
        let session_id = match scope {
            MemoryScope::Project => None,
            MemoryScope::Session => Some(
                session_id
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Session-scoped memory must be created with an active session_id".to_string())?
                    .to_string(),
            ),
        };
        let memory = ProjectMemory {
            id: Uuid::new_v4().to_string(),
            revision: 1,
            project_id: project_id.to_string(),
            kind,
            status: MemoryStatus::Proposed,
            scope,
            title: title.trim().to_string(),
            content: content.trim().to_string(),
            source: MemorySource {
                session_id: session_id.clone(),
                conversation_id: None,
                reference_paths,
                origin: "agent".to_string(),
            },
            confidence,
            created_at: now,
            updated_at: now,
            expires_at: Some(now + DEFAULT_TTL_MS),
            supersedes: None,
            schema_stale_reason: None,
        };
        write_proposal(&project_root, &memory)?;
        append_audit(
            &project_root,
            AuditEvent::Proposed {
                memory_id: memory.id.clone(),
                scope,
                actor: session_id.unwrap_or_else(|| "project".to_string()),
                at: now,
            },
        )?;
        update_index(&project_root)?;
        Ok(MemoryProposal { memory, created_at: now, reason: reason.to_string() })
    }

    pub fn accept_proposal(
        project_path: &str,
        project_id: &str,
        memory_id: &str,
    ) -> Result<ProjectMemory, String> {
        let project_root = canonical_project_root(project_path)?;
        let mut memory = read_proposal(&project_root, memory_id)?;
        memory.project_id = project_id.to_string();
        memory.status = MemoryStatus::Accepted;
        memory.updated_at = now_ms();
        write_active(&project_root, &memory)?;
        remove_proposal(&project_root, memory_id)?;
        enforce_size_limits(&project_root)?;
        append_audit(
            &project_root,
            AuditEvent::Accepted {
                memory_id: memory.id.clone(),
                scope: memory.scope,
                actor: "user".to_string(),
                at: memory.updated_at,
            },
        )?;
        update_index(&project_root)?;
        Ok(memory)
    }

    pub fn reject_proposal(
        project_path: &str,
        memory_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        let project_root = canonical_project_root(project_path)?;
        let memory = read_proposal(&project_root, memory_id)?;
        remove_proposal(&project_root, memory_id)?;
        append_audit(
            &project_root,
            AuditEvent::Rejected {
                memory_id: memory.id.clone(),
                scope: memory.scope,
                actor: "user".to_string(),
                at: now_ms(),
                reason: reason.to_string(),
            },
        )?;
        update_index(&project_root)?;
        Ok(())
    }

    pub fn archive_memory(
        project_path: &str,
        memory_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        let project_root = canonical_project_root(project_path)?;
        let mut memory = read_active(&project_root, memory_id)?;
        memory.status = MemoryStatus::Archived;
        memory.updated_at = now_ms();
        write_archive(&project_root, &memory)?;
        remove_active(&project_root, memory_id)?;
        append_audit(
            &project_root,
            AuditEvent::Archived {
                memory_id: memory.id.clone(),
                scope: memory.scope,
                actor: "user".to_string(),
                at: memory.updated_at,
                reason: reason.to_string(),
            },
        )?;
        update_index(&project_root)?;
        Ok(())
    }

    pub fn redact_memory(
        project_path: &str,
        memory_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        let project_root = canonical_project_root(project_path)?;
        let mut memory = read_active(&project_root, memory_id)?;
        memory.title = "[redacted]".to_string();
        memory.content = String::new();
        memory.status = MemoryStatus::Archived;
        memory.updated_at = now_ms();
        memory.schema_stale_reason = Some(format!("redacted: {reason}"));
        write_archive(&project_root, &memory)?;
        remove_active(&project_root, memory_id)?;
        append_audit(
            &project_root,
            AuditEvent::Redacted {
                memory_id: memory.id.clone(),
                scope: memory.scope,
                actor: "user".to_string(),
                at: memory.updated_at,
                reason: reason.to_string(),
            },
        )?;
        update_index(&project_root)?;
        Ok(())
    }

    pub fn list_active(
        project_path: &str,
        project_id: &str,
        session_id: Option<&str>,
    ) -> Result<Vec<ProjectMemory>, String> {
        let project_root = canonical_project_root(project_path)?;
        let now = now_ms();
        let mut out = Vec::new();
        for memory in read_active_all(&project_root)? {
            if memory.project_id != project_id {
                continue;
            }
            if memory.status != MemoryStatus::Accepted {
                continue;
            }
            if memory.schema_stale_reason.is_some() {
                continue;
            }
            if let Some(expires_at) = memory.expires_at {
                if expires_at <= now {
                    continue;
                }
            }
            match memory.scope {
                MemoryScope::Project => out.push(memory),
                MemoryScope::Session => {
                    if memory.source.session_id.as_deref() == session_id && session_id.is_some() {
                        out.push(memory);
                    }
                }
            }
        }
        Ok(out)
    }

    pub fn search(
        project_path: &str,
        project_id: &str,
        session_id: Option<&str>,
        query: &str,
        kind: Option<MemoryKind>,
        limit: usize,
    ) -> Result<Vec<MemorySearchHit>, String> {
        let limit = limit.clamp(1, 32);
        let active = Self::list_active(project_path, project_id, session_id)?;
        let normalized = query.trim().to_lowercase();
        let tokens: Vec<&str> = if normalized.is_empty() {
            Vec::new()
        } else {
            normalized.split_whitespace().collect()
        };
        let mut scored: Vec<MemorySearchHit> = active
            .into_iter()
            .filter(|memory| kind.is_none_or(|kind| memory.kind == kind))
            .map(|memory| {
                let score = if tokens.is_empty() {
                    rank_by_confidence(&memory)
                } else {
                    score_memory(&memory, &tokens)
                };
                MemorySearchHit { memory, score }
            })
            .filter(|hit| tokens.is_empty() || hit.score > 0.0)
            .collect();
        scored.sort_by(|left, right| {
            right.score.partial_cmp(&left.score).unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| right.memory.updated_at.cmp(&left.memory.updated_at))
        });
        scored.truncate(limit);
        Ok(scored)
    }

    pub fn proposals(
        project_path: &str,
        project_id: &str,
    ) -> Result<Vec<ProjectMemory>, String> {
        let project_root = canonical_project_root(project_path)?;
        let mut out = Vec::new();
        for memory in read_proposals_all(&project_root)? {
            if memory.project_id == project_id {
                out.push(memory);
            }
        }
        out.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(out)
    }

    pub fn archive(
        project_path: &str,
        project_id: &str,
    ) -> Result<Vec<ProjectMemory>, String> {
        let project_root = canonical_project_root(project_path)?;
        let mut out = Vec::new();
        for memory in read_archive_all(&project_root)? {
            if memory.project_id == project_id {
                out.push(memory);
            }
        }
        out.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(out)
    }

    pub fn mark_schema_stale(
        project_path: &str,
        predicate: impl Fn(&ProjectMemory) -> Option<String>,
    ) -> Result<usize, String> {
        let project_root = canonical_project_root(project_path)?;
        let mut count = 0usize;
        for mut memory in read_active_all(&project_root)? {
            if memory.status == MemoryStatus::SchemaStale {
                continue;
            }
            if let Some(reason) = predicate(&memory) {
                memory.status = MemoryStatus::SchemaStale;
                memory.schema_stale_reason = Some(reason.clone());
                memory.updated_at = now_ms();
                write_active(&project_root, &memory)?;
                append_audit(
                    &project_root,
                    AuditEvent::SchemaStale {
                        memory_id: memory.id.clone(),
                        scope: memory.scope,
                        actor: "system".to_string(),
                        at: memory.updated_at,
                        reason,
                    },
                )?;
                count += 1;
            }
        }
        if count > 0 { update_index(&project_root)?; }
        Ok(count)
    }
}

fn rank_by_confidence(memory: &ProjectMemory) -> f32 {
    match memory.confidence {
        MemoryConfidence::UserConfirmed => 0.9,
        MemoryConfidence::EvidenceBacked => 0.7,
        MemoryConfidence::AgentSuggested => 0.4,
    }
}

fn score_memory(memory: &ProjectMemory, tokens: &[&str]) -> f32 {
    let title = memory.title.to_lowercase();
    let content = memory.content.to_lowercase();
    let mut score = 0.0_f32;
    for token in tokens {
        if title.contains(token) {
            score += 2.0;
        }
        if content.contains(token) {
            score += 1.0;
        }
    }
    score * rank_by_confidence(memory)
}

fn validate_title(title: &str) -> Result<(), String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("Memory title must not be empty".to_string());
    }
    if trimmed.len() > MAX_TITLE_BYTES {
        return Err(format!("Memory title exceeds {MAX_TITLE_BYTES} bytes"));
    }
    Ok(())
}

fn validate_content(content: &str) -> Result<(), String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("Memory content must not be empty".to_string());
    }
    if trimmed.len() > MAX_CONTENT_BYTES {
        return Err(format!("Memory content exceeds {MAX_CONTENT_BYTES} bytes"));
    }
    Ok(())
}

fn reject_sensitive(content: &str) -> Result<(), String> {
    let lower = content.to_lowercase();
    for pattern in SENSITIVE_PATTERNS {
        if lower.contains(&pattern.to_lowercase()) {
            return Err(format!("Memory content rejected: contains sensitive pattern '{pattern}'. Remove tokens, keys, cookies, full chat transcripts, image data, or absolute system paths before saving."));
        }
    }
    Ok(())
}

fn canonical_project_root(project_path: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_path)
        .canonicalize()
        .map_err(|error| format!("Invalid project path: {error}"))?;
    if !root.is_dir() || !root.join(".llm-wiki").is_dir() {
        return Err("Memory operations require a valid project with .llm-wiki state".to_string());
    }
    Ok(root)
}

fn memory_dir(root: &Path) -> PathBuf { root.join(MEMORY_DIR) }
fn active_dir(root: &Path) -> PathBuf { memory_dir(root).join("active") }
fn proposal_dir(root: &Path) -> PathBuf { memory_dir(root).join("proposals") }
fn archive_dir(root: &Path) -> PathBuf { memory_dir(root).join("archive") }
fn audit_path(root: &Path) -> PathBuf { memory_dir(root).join("audit.jsonl") }
fn index_path(root: &Path) -> PathBuf { memory_dir(root).join("index.json") }

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    let json = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("json.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, &json).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

fn read_json_atomic<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path).map_err(|_| "Memory entry was not found".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "Memory entry is invalid".to_string())
}

fn write_proposal(root: &Path, memory: &ProjectMemory) -> Result<(), String> {
    let path = proposal_dir(root).join(format!("{}.json", memory.id));
    write_json_atomic(&path, memory)
}

fn write_active(root: &Path, memory: &ProjectMemory) -> Result<(), String> {
    let path = active_dir(root).join(format!("{}.json", memory.id));
    write_json_atomic(&path, memory)
}

fn write_archive(root: &Path, memory: &ProjectMemory) -> Result<(), String> {
    let path = archive_dir(root).join(format!("{}.json", memory.id));
    write_json_atomic(&path, memory)
}

fn remove_proposal(root: &Path, memory_id: &str) -> Result<(), String> {
    let _ = fs::remove_file(proposal_dir(root).join(format!("{memory_id}.json")));
    Ok(())
}

fn remove_active(root: &Path, memory_id: &str) -> Result<(), String> {
    let _ = fs::remove_file(active_dir(root).join(format!("{memory_id}.json")));
    Ok(())
}

fn read_proposal(root: &Path, memory_id: &str) -> Result<ProjectMemory, String> {
    if !is_safe_memory_id(memory_id) { return Err("Invalid memory id".to_string()); }
    let path = proposal_dir(root).join(format!("{memory_id}.json"));
    read_json_atomic(&path)
}

fn read_active(root: &Path, memory_id: &str) -> Result<ProjectMemory, String> {
    if !is_safe_memory_id(memory_id) { return Err("Invalid memory id".to_string()); }
    let path = active_dir(root).join(format!("{memory_id}.json"));
    read_json_atomic(&path)
}

fn read_active_all(root: &Path) -> Result<Vec<ProjectMemory>, String> {
    read_dir_entries(&active_dir(root))
}

fn read_proposals_all(root: &Path) -> Result<Vec<ProjectMemory>, String> {
    read_dir_entries(&proposal_dir(root))
}

fn read_archive_all(root: &Path) -> Result<Vec<ProjectMemory>, String> {
    read_dir_entries(&archive_dir(root))
}

fn read_dir_entries(dir: &Path) -> Result<Vec<ProjectMemory>, String> {
    if !dir.exists() { return Ok(Vec::new()); }
    let entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().extension().is_some_and(|ext| ext == "json") { continue; }
        match read_json_atomic::<ProjectMemory>(&entry.path()) {
            Ok(memory) => out.push(memory),
            Err(_) => continue,
        }
    }
    Ok(out)
}

fn append_audit(root: &Path, event: AuditEvent) -> Result<(), String> {
    let path = audit_path(root);
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    let raw = serde_json::to_string(&event).map_err(|error| error.to_string())?;
    let trimmed = if let Ok(existing) = fs::read_to_string(&path) {
        if existing.len() + raw.len() + 1 > MAX_AUDIT_BYTES {
            return Ok(());
        }
        format!("{existing}{raw}\n")
    } else {
        format!("{raw}\n")
    };
    fs::write(&path, trimmed).map_err(|error| error.to_string())
}

fn update_index(root: &Path) -> Result<(), String> {
    let active_count = count_json_files(&active_dir(root))?;
    let proposal_count = count_json_files(&proposal_dir(root))?;
    let index = MemoryIndex { updated_at: now_ms(), active_count, proposal_count };
    write_json_atomic(&index_path(root), &index)
}

fn count_json_files(dir: &Path) -> Result<usize, String> {
    if !dir.exists() { return Ok(0); }
    let entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    Ok(entries.flatten().filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json")).count())
}

fn enforce_size_limits(root: &Path) -> Result<(), String> {
    let total = count_json_files(&active_dir(root))?;
    if total > MAX_PROJECT_MEMORIES {
        return Err(format!(
            "Active memory entry limit reached ({MAX_PROJECT_MEMORIES}). Archive or redact existing memories before adding new ones."
        ));
    }
    Ok(())
}

fn is_safe_memory_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok()
}

pub fn record_app_write(root: &Path) {
    file_sync::mark_app_write_path(&active_dir(root));
    file_sync::mark_app_write_path(&proposal_dir(root));
    file_sync::mark_app_write_path(&archive_dir(root));
}

pub fn file_paths(root: &Path) -> Vec<PathBuf> {
    vec![active_dir(root), proposal_dir(root), archive_dir(root)]
}

pub fn excluded_watch_paths(root: &Path) -> Vec<PathBuf> { file_paths(root) }

pub fn content_hash(value: &str) -> String { format!("sha256:{:x}", Sha256::digest(value.as_bytes())) }

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[allow(dead_code)]
pub fn kind_label(kind: MemoryKind) -> &'static str {
    match kind {
        MemoryKind::UserPreference => "user_preference",
        MemoryKind::ProjectConvention => "project_convention",
        MemoryKind::ConfirmedFact => "confirmed_fact",
        MemoryKind::Decision => "decision",
        MemoryKind::OpenQuestion => "open_question",
        MemoryKind::SchemaNote => "schema_note",
    }
}

#[allow(dead_code)]
pub fn status_label(status: MemoryStatus) -> &'static str {
    match status {
        MemoryStatus::Proposed => "proposed",
        MemoryStatus::Accepted => "accepted",
        MemoryStatus::Rejected => "rejected",
        MemoryStatus::Archived => "archived",
        MemoryStatus::SchemaStale => "schema_stale",
    }
}

pub fn project_memory_root_component() -> &'static str { MEMORY_DIR }

pub const MEMORY_IMPORT_DIR: &str = "imports";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportCandidate {
    pub id: String,
    pub kind: MemoryKind,
    pub scope: MemoryScope,
    pub title: String,
    pub content: String,
    pub confidence: MemoryConfidence,
    pub source_label: String,
    pub reference_paths: Vec<String>,
    pub sensitive: bool,
    pub duplicate_of: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportBatch {
    pub id: String,
    pub source_file: String,
    pub source_format: String,
    pub candidates: Vec<MemoryImportCandidate>,
    pub created_at: i64,
}

pub struct MemoryImporter;

impl MemoryImporter {
    pub fn parse(
        project_path: &str,
        source_format: &str,
        source_label: &str,
        raw: &str,
    ) -> Result<MemoryImportBatch, String> {
        let format = source_format.to_lowercase();
        let candidates = match format.as_str() {
            "jsonl" => parse_jsonl(raw)?,
            "json" => parse_json_array(raw)?,
            "markdown" | "md" => parse_markdown(raw)?,
            other => return Err(format!("Unsupported memory import format: {other}")),
        };
        let project_root = canonical_project_root(project_path)?;
        let mut reviewed = Vec::new();
        let mut seen_titles = std::collections::HashSet::new();
        for mut candidate in candidates {
            candidate.source_label = source_label.to_string();
            if candidate.title.trim().is_empty() || candidate.content.trim().is_empty() {
                continue;
            }
            if reject_sensitive(&candidate.content).is_err() {
                candidate.sensitive = true;
            }
            if !seen_titles.insert(candidate.title.trim().to_lowercase()) {
                candidate.duplicate_of = Some(candidate.id.clone());
            }
            reviewed.push(candidate);
        }
        let id = Uuid::new_v4().to_string();
        let batch = MemoryImportBatch {
            id,
            source_file: source_label.to_string(),
            source_format: format,
            candidates: reviewed,
            created_at: now_ms(),
        };
        persist_import_batch(&project_root, &batch)?;
        Ok(batch)
    }

    pub fn accept_candidate(
        project_path: &str,
        project_id: &str,
        session_id: Option<&str>,
        batch_id: &str,
        candidate_id: &str,
    ) -> Result<ProjectMemory, String> {
        let project_root = canonical_project_root(project_path)?;
        let batch = load_import_batch(&project_root, batch_id)?;
        let candidate = batch
            .candidates
            .iter()
            .find(|item| item.id == candidate_id)
            .ok_or_else(|| "Memory import candidate was not found".to_string())?;
        if candidate.sensitive {
            return Err("Memory import candidate contains sensitive content; remove it before accepting".to_string());
        }
        let proposal = Self::create_proposal_from_candidate(candidate)?;
        let _ = project_id;
        let _ = session_id;
        let _ = batch_id;
        let memory = Self::accept_external_memory(&project_root, &proposal)?;
        Ok(memory)
    }

    pub fn accept_external_memory(project_root: &Path, proposal: &MemoryProposal) -> Result<ProjectMemory, String> {
        let mut memory = proposal.memory.clone();
        memory.status = MemoryStatus::Accepted;
        memory.updated_at = now_ms();
        write_active(project_root, &memory)?;
        append_audit(
            project_root,
            AuditEvent::Accepted {
                memory_id: memory.id.clone(),
                scope: memory.scope,
                actor: "import".to_string(),
                at: memory.updated_at,
            },
        )?;
        update_index(project_root)?;
        Ok(memory)
    }

    pub fn create_proposal_from_candidate(candidate: &MemoryImportCandidate) -> Result<MemoryProposal, String> {
        validate_title(&candidate.title)?;
        validate_content(&candidate.content)?;
        if candidate.sensitive {
            reject_sensitive(&candidate.content)?;
        }
        Ok(MemoryProposal {
            memory: ProjectMemory {
                id: candidate.id.clone(),
                revision: 1,
                project_id: String::new(),
                kind: candidate.kind,
                status: MemoryStatus::Proposed,
                scope: candidate.scope,
                title: candidate.title.trim().to_string(),
                content: candidate.content.trim().to_string(),
                source: MemorySource {
                    session_id: None,
                    conversation_id: None,
                    reference_paths: Some(candidate.reference_paths.clone()),
                    origin: format!("import:{}", candidate.source_label),
                },
                confidence: candidate.confidence,
                created_at: now_ms(),
                updated_at: now_ms(),
                expires_at: Some(now_ms() + DEFAULT_TTL_MS),
                supersedes: None,
                schema_stale_reason: None,
            },
            created_at: now_ms(),
            reason: format!("Imported from {}", candidate.source_label),
        })
    }
}

fn parse_jsonl(raw: &str) -> Result<Vec<MemoryImportCandidate>, String> {
    let mut out = Vec::new();
    for (index, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { continue; }
        let value: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|error| format!("Invalid JSONL entry on line {}: {}", index + 1, error))?;
        out.push(candidate_from_value(&value)?);
    }
    Ok(out)
}

fn parse_json_array(raw: &str) -> Result<Vec<MemoryImportCandidate>, String> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| format!("Invalid memory JSON: {error}"))?;
    let array = value.as_array().ok_or_else(|| "Expected a top-level JSON array of memory entries".to_string())?;
    let mut out = Vec::new();
    for item in array {
        out.push(candidate_from_value(item)?);
    }
    Ok(out)
}

fn parse_markdown(raw: &str) -> Result<Vec<MemoryImportCandidate>, String> {
    let mut out = Vec::new();
    let mut current: Option<MemoryImportCandidate> = None;
    let mut content_lines: Vec<String> = Vec::new();
    let flush = |current: &mut Option<MemoryImportCandidate>, lines: &mut Vec<String>| -> Option<MemoryImportCandidate> {
        if let Some(mut entry) = current.take() {
            entry.content = lines.join("\n");
            lines.clear();
            return Some(entry);
        }
        lines.clear();
        None
    };
    let flush_state = flush;
    for raw_line in raw.lines() {
        let line = raw_line.trim_end();
        if let Some(rest) = line.strip_prefix("## ") {
            if let Some(entry) = flush_state(&mut current, &mut content_lines) {
                out.push(entry);
            }
            let title = rest.trim().to_string();
            current = Some(MemoryImportCandidate {
                id: Uuid::new_v4().to_string(),
                kind: MemoryKind::UserPreference,
                scope: MemoryScope::Project,
                title,
                content: String::new(),
                confidence: MemoryConfidence::UserConfirmed,
                source_label: String::new(),
                reference_paths: Vec::new(),
                sensitive: false,
                duplicate_of: None,
            });
            continue;
        }
        if current.is_some() {
            content_lines.push(line.to_string());
        }
    }
    if let Some(entry) = flush_state(&mut current, &mut content_lines) {
        out.push(entry);
    }
    Ok(out)
}

fn candidate_from_value(value: &serde_json::Value) -> Result<MemoryImportCandidate, String> {
    let obj = value.as_object().ok_or_else(|| "Each memory entry must be a JSON object".to_string())?;
    let title = obj
        .get("title")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "memory entry missing 'title'".to_string())?
        .to_string();
    let content = obj
        .get("content")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "memory entry missing 'content'".to_string())?
        .to_string();
    let kind = parse_kind(obj.get("kind").and_then(serde_json::Value::as_str))?;
    let scope = match obj.get("scope").and_then(serde_json::Value::as_str) {
        Some("session") => MemoryScope::Session,
        _ => MemoryScope::Project,
    };
    let confidence = match obj.get("confidence").and_then(serde_json::Value::as_str) {
        Some("evidence_backed") => MemoryConfidence::EvidenceBacked,
        Some("agent_suggested") => MemoryConfidence::AgentSuggested,
        _ => MemoryConfidence::UserConfirmed,
    };
    let reference_paths = obj
        .get("referencePaths")
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().filter_map(|value| value.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    Ok(MemoryImportCandidate {
        id: Uuid::new_v4().to_string(),
        kind,
        scope,
        title,
        content,
        confidence,
        source_label: String::new(),
        reference_paths,
        sensitive: false,
        duplicate_of: None,
    })
}

fn parse_kind(value: Option<&str>) -> Result<MemoryKind, String> {
    Ok(match value {
        None | Some("user_preference") => MemoryKind::UserPreference,
        Some("project_convention") => MemoryKind::ProjectConvention,
        Some("confirmed_fact") => MemoryKind::ConfirmedFact,
        Some("decision") => MemoryKind::Decision,
        Some("open_question") => MemoryKind::OpenQuestion,
        Some("schema_note") => MemoryKind::SchemaNote,
        Some(other) => return Err(format!("Unknown memory kind in import: {other}")),
    })
}

fn import_dir(root: &Path) -> PathBuf { memory_dir(root).join(MEMORY_IMPORT_DIR) }

fn persist_import_batch(root: &Path, batch: &MemoryImportBatch) -> Result<(), String> {
    let dir = import_dir(root);
    if !dir.exists() { fs::create_dir_all(&dir).map_err(|error| error.to_string())?; }
    let path = dir.join(format!("{}.json", batch.id));
    write_json_atomic(&path, batch)
}

fn load_import_batch(root: &Path, batch_id: &str) -> Result<MemoryImportBatch, String> {
    if !is_safe_memory_id(batch_id) { return Err("Invalid memory import batch id".to_string()); }
    let path = import_dir(root).join(format!("{batch_id}.json"));
    read_json_atomic(&path)
}

pub fn list_import_batches(project_path: &str, project_id: &str) -> Result<Vec<MemoryImportBatch>, String> {
    let project_root = canonical_project_root(project_path)?;
    let dir = import_dir(&project_root);
    if !dir.exists() { return Ok(Vec::new()); }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|error| error.to_string())?.flatten() {
        if !entry.path().extension().is_some_and(|ext| ext == "json") { continue; }
        if let Ok(batch) = read_json_atomic::<MemoryImportBatch>(&entry.path()) {
            if !batch.candidates.is_empty() { out.push(batch); }
        }
    }
    out.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    let _ = project_id;
    Ok(out)
}

pub fn discard_import_batch(project_path: &str, batch_id: &str) -> Result<(), String> {
    let project_root = canonical_project_root(project_path)?;
    let path = import_dir(&project_root).join(format!("{batch_id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn build_injection(
    memories: &[ProjectMemory],
    max_chars: usize,
) -> String {
    if memories.is_empty() { return String::new(); }
    let mut out = String::from("\n<project_memory>\n");
    let mut remaining = max_chars;
    for memory in memories {
        let line = format!(
            "- [{}, {}, scope={}] {}\n",
            kind_label(memory.kind),
            confidence_label(memory.confidence),
            scope_label(memory.scope),
            memory.title,
        );
        out.push_str(&line);
        let body = memory.content.trim();
        let body_chars = body.chars().count();
        if body_chars > remaining {
            let take = remaining.saturating_sub(8).min(body_chars);
            let truncated: String = body.chars().take(take).collect();
            out.push_str("  content: ");
            out.push_str(&truncated);
            out.push_str("…\n");
            out.push_str("</project_memory>\n");
            return out;
        }
        out.push_str("  content: ");
        out.push_str(body);
        out.push('\n');
        remaining = remaining.saturating_sub(body_chars + line.len());
        if remaining < 16 { break; }
    }
    out.push_str("</project_memory>\n");
    out
}

fn confidence_label(confidence: MemoryConfidence) -> &'static str {
    match confidence {
        MemoryConfidence::UserConfirmed => "user_confirmed",
        MemoryConfidence::EvidenceBacked => "evidence_backed",
        MemoryConfidence::AgentSuggested => "agent_suggested",
    }
}

fn scope_label(scope: MemoryScope) -> &'static str {
    match scope {
        MemoryScope::Project => "project",
        MemoryScope::Session => "session",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> PathBuf {
        let root = std::env::temp_dir().join(format!("llm-wiki-memory-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        root
    }

    fn references_unique<T: Eq + std::hash::Hash>(values: Vec<T>) -> HashSet<T> {
        values.into_iter().collect()
    }

    #[test]
    fn sensitive_content_is_rejected() {
        let root = project();
        let err = ProjectMemoryStore::create_proposal(
            root.to_str().unwrap(),
            "project",
            Some("session"),
            MemoryKind::UserPreference,
            MemoryScope::Project,
            "API access",
            "My token is ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            MemoryConfidence::UserConfirmed,
            None,
            "shared during chat",
        )
        .unwrap_err();
        assert!(err.contains("sensitive"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn proposal_accept_search_and_archive_lifecycle_works() {
        let root = project();
        let proposal = ProjectMemoryStore::create_proposal(
            root.to_str().unwrap(),
            "project",
            Some("session"),
            MemoryKind::ProjectConvention,
            MemoryScope::Project,
            "Person pages live under wiki/people",
            "人物页面统一存放在 wiki/people/。",
            MemoryConfidence::UserConfirmed,
            Some(vec!["wiki/people/ada.md".to_string()]),
            "user explicit",
        )
        .unwrap();
        let accepted = ProjectMemoryStore::accept_proposal(
            root.to_str().unwrap(),
            "project",
            &proposal.memory.id,
        )
        .unwrap();
        assert_eq!(accepted.status, MemoryStatus::Accepted);
        let hits = ProjectMemoryStore::search(
            root.to_str().unwrap(),
            "project",
            Some("session"),
            "people",
            None,
            10,
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        ProjectMemoryStore::archive_memory(root.to_str().unwrap(), &proposal.memory.id, "moved").unwrap();
        let hits = ProjectMemoryStore::search(
            root.to_str().unwrap(),
            "project",
            Some("session"),
            "people",
            None,
            10,
        )
        .unwrap();
        assert!(hits.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn session_memory_is_hidden_from_other_sessions() {
        let root = project();
        let proposal = ProjectMemoryStore::create_proposal(
            root.to_str().unwrap(),
            "project",
            Some("session-a"),
            MemoryKind::UserPreference,
            MemoryScope::Session,
            "Use british english",
            "Prefer british spelling in summaries.",
            MemoryConfidence::UserConfirmed,
            None,
            "transient",
        )
        .unwrap();
        ProjectMemoryStore::accept_proposal(
            root.to_str().unwrap(),
            "project",
            &proposal.memory.id,
        )
        .unwrap();
        let here = ProjectMemoryStore::search(
            root.to_str().unwrap(),
            "project",
            Some("session-a"),
            "british",
            None,
            10,
        )
        .unwrap();
        assert_eq!(here.len(), 1);
        let other = ProjectMemoryStore::search(
            root.to_str().unwrap(),
            "project",
            Some("session-b"),
            "british",
            None,
            10,
        )
        .unwrap();
        assert!(other.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn redacted_memory_strips_content_but_preserves_audit() {
        let root = project();
        let proposal = ProjectMemoryStore::create_proposal(
            root.to_str().unwrap(),
            "project",
            Some("session"),
            MemoryKind::ConfirmedFact,
            MemoryScope::Project,
            "Project codename",
            "Project codename: Atlas",
            MemoryConfidence::EvidenceBacked,
            None,
            "user clarified",
        )
        .unwrap();
        ProjectMemoryStore::accept_proposal(
            root.to_str().unwrap(),
            "project",
            &proposal.memory.id,
        )
        .unwrap();
        ProjectMemoryStore::redact_memory(root.to_str().unwrap(), &proposal.memory.id, "leaked").unwrap();
        let hits = ProjectMemoryStore::search(
            root.to_str().unwrap(),
            "project",
            Some("session"),
            "atlas",
            None,
            10,
        )
        .unwrap();
        assert!(hits.is_empty());
        let audit = fs::read_to_string(root.join(".llm-wiki/memory/audit.jsonl")).unwrap();
        assert!(audit.contains("redacted"));
        assert!(references_unique::<String>(vec![audit.clone()]).contains(&audit));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn importer_parses_jsonl_and_marks_sensitive_entries() {
        let root = project();
        let raw = [
            r#"{"kind":"project_convention","title":"Person pages in wiki/people","content":"人物页面统一存放在 wiki/people/。","scope":"project","confidence":"user_confirmed"}"#,
            r#"{"kind":"user_preference","title":"Bad secret","content":"token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"}"#,
            r#"{"title":"Empty content","content":""}"#,
        ].join("\n");
        let batch = MemoryImporter::parse(root.to_str().unwrap(), "jsonl", "codex-export.jsonl", &raw).unwrap();
        assert_eq!(batch.candidates.len(), 2);
        assert_eq!(batch.candidates[0].title, "Person pages in wiki/people");
        assert!(batch.candidates[1].sensitive);
        let accepted = MemoryImporter::accept_candidate(
            root.to_str().unwrap(),
            "project",
            Some("session"),
            &batch.id,
            &batch.candidates[0].id,
        )
        .unwrap();
        assert_eq!(accepted.title, "Person pages in wiki/people");
        assert!(MemoryImporter::accept_candidate(
            root.to_str().unwrap(),
            "project",
            Some("session"),
            &batch.id,
            &batch.candidates[1].id,
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn importer_parses_markdown_with_duplicate_detection() {
        let root = project();
        let raw = [
            "# Memory Export",
            "",
            "## Use British english",
            "Prefer british spelling in summaries.",
            "",
            "## Use British english",
            "Restated: spell summaries with british english.",
        ].join("\n");
        let batch = MemoryImporter::parse(root.to_str().unwrap(), "markdown", "notes.md", &raw).unwrap();
        assert_eq!(batch.candidates.len(), 2);
        assert!(batch.candidates[1].duplicate_of.is_some());
        let _ = fs::remove_dir_all(root);
    }
}