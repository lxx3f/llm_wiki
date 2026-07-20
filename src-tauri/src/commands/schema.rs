//! Project Schema proposal, validation, impact-audit, and apply service.
//!
//! `schema.md` is always the human-editable source of truth. This module keeps
//! only compiled snapshots, proposals, and audit reports below `.llm-wiki/`.
//! Proposal application uses the source hash captured at creation time as a CAS
//! guard, so an external edit can never be overwritten by a stale Agent/UI run.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::commands::{file_history, file_sync};
use crate::panic_guard::run_guarded_async;

const MAX_SCHEMA_BYTES: usize = 256 * 1024;
const MAX_PROPOSALS: usize = 128;
const MAX_AUDIT_PAGES: usize = 2_000;
const SCHEMA_DIR: &str = ".llm-wiki/schema";
const RESERVED_PATHS: &[&str] = &["wiki/index.md", "wiki/log.md", "wiki/overview.md"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiagnostic {
    pub severity: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompiledSchema {
    pub schema_version: u32,
    pub content_hash: String,
    pub type_dirs: HashMap<String, String>,
    pub diagnostics: Vec<SchemaDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaImpactPage {
    pub path: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaImpactReport {
    pub schema_hash: String,
    pub pages_scanned: usize,
    pub affected_pages: Vec<SchemaImpactPage>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaProposal {
    pub id: String,
    pub project_id: String,
    pub session_id: String,
    pub base_schema_hash: String,
    pub proposed_schema: String,
    pub compiled: CompiledSchema,
    pub impact: SchemaImpactReport,
    pub required_directories: Vec<String>,
    pub created_at: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaApplyResult {
    pub schema_hash: String,
    pub schema_version: u32,
    pub impact: SchemaImpactReport,
    pub created_directories: Vec<String>,
}

#[tauri::command]
pub async fn schema_get_compiled(project_path: String) -> Result<CompiledSchema, String> {
    run_guarded_async("schema_get_compiled", async move {
        tauri::async_runtime::spawn_blocking(move || get_compiled_schema(&project_path))
            .await
            .map_err(|error| format!("schema_get_compiled task join error: {error}"))?
    })
    .await
}

#[tauri::command]
pub async fn schema_validate(project_path: String) -> Result<SchemaImpactReport, String> {
    run_guarded_async("schema_validate", async move {
        tauri::async_runtime::spawn_blocking(move || {
            let (_, schema) = read_canonical_schema(&project_path)?;
            let compiled = compile_schema(&schema);
            audit_project_schema(&project_path, &compiled)
        })
        .await
        .map_err(|error| format!("schema_validate task join error: {error}"))?
    })
    .await
}

pub fn get_compiled_schema(project_path: &str) -> Result<CompiledSchema, String> {
    let (_, schema) = read_canonical_schema(project_path)?;
    Ok(compile_schema(&schema))
}

pub fn create_schema_proposal(
    project_path: &str,
    project_id: &str,
    session_id: &str,
    proposed_schema: String,
) -> Result<SchemaProposal, String> {
    validate_schema_size(&proposed_schema)?;
    let (_, current_schema) = read_canonical_schema(project_path)?;
    let compiled = compile_schema(&proposed_schema);
    if compiled.diagnostics.iter().any(|item| item.severity == "error") {
        return Err(render_diagnostics(&compiled.diagnostics));
    }

    let impact = audit_project_schema(project_path, &compiled)?;
    let proposal = SchemaProposal {
        id: Uuid::new_v4().to_string(),
        project_id: project_id.to_string(),
        session_id: session_id.to_string(),
        base_schema_hash: content_hash(&current_schema),
        proposed_schema,
        required_directories: required_directories(&compiled),
        compiled,
        impact,
        created_at: chrono::Utc::now().timestamp_millis(),
        status: "pending".to_string(),
    };
    save_proposal(project_path, &proposal)?;
    Ok(proposal)
}

pub fn apply_schema_proposal(
    project_path: &str,
    project_id: &str,
    session_id: &str,
    proposal_id: &str,
    expected_schema_hash: &str,
) -> Result<SchemaApplyResult, String> {
    let mut proposal = load_proposal(project_path, proposal_id)?;
    if proposal.project_id != project_id || proposal.session_id != session_id {
        return Err("Schema proposal was not found for this project and session".to_string());
    }
    if proposal.status != "pending" {
        return Err("Schema proposal is no longer pending".to_string());
    }
    if proposal.base_schema_hash != expected_schema_hash {
        return Err("Schema proposal does not match the requested base schema revision".to_string());
    }

    let (schema_path, current_schema) = read_canonical_schema(project_path)?;
    if content_hash(&current_schema) != proposal.base_schema_hash {
        return Err("schema.md changed after this proposal was created; create a new proposal before applying it".to_string());
    }

    let compiled = compile_schema(&proposal.proposed_schema);
    if compiled.diagnostics.iter().any(|item| item.severity == "error") {
        return Err(render_diagnostics(&compiled.diagnostics));
    }

    file_history::record_file_version(&schema_path, "baseline", "before.schema.apply");
    atomic_write(&schema_path, &proposal.proposed_schema)?;
    file_history::record_file_version(&schema_path, "agent", "schema.apply");
    file_sync::mark_app_write_path(&schema_path);

    let mut created_directories = Vec::new();
    for directory in &proposal.required_directories {
        let path = safe_wiki_directory(project_path, directory)?;
        if !path.exists() {
            fs::create_dir_all(&path)
                .map_err(|error| format!("Failed to create schema directory '{}': {error}", path.display()))?;
            file_sync::mark_app_write_path(&path);
            created_directories.push(directory.clone());
        }
    }

    let impact = audit_project_schema(project_path, &compiled)?;
    save_audit(project_path, &impact)?;
    proposal.status = "applied".to_string();
    save_proposal(project_path, &proposal)?;

    Ok(SchemaApplyResult {
        schema_hash: compiled.content_hash,
        schema_version: compiled.schema_version,
        impact,
        created_directories,
    })
}

pub fn reject_schema_proposal(
    project_path: &str,
    project_id: &str,
    session_id: &str,
    proposal_id: &str,
) -> Result<(), String> {
    let mut proposal = load_proposal(project_path, proposal_id)?;
    if proposal.project_id != project_id || proposal.session_id != session_id {
        return Err("Schema proposal was not found for this project and session".to_string());
    }
    if proposal.status != "pending" {
        return Err("Schema proposal is no longer pending".to_string());
    }
    proposal.status = "rejected".to_string();
    save_proposal(project_path, &proposal)
}

fn read_canonical_schema(project_path: &str) -> Result<(PathBuf, String), String> {
    let root = canonical_project_root(project_path)?;
    let path = root.join("schema.md");
    let metadata = fs::metadata(&path)
        .map_err(|_| "Project root must contain schema.md before schema changes can be planned".to_string())?;
    if !metadata.is_file() || metadata.len() as usize > MAX_SCHEMA_BYTES {
        return Err("schema.md must be a regular file smaller than 256 KiB".to_string());
    }
    let content = fs::read_to_string(&path).map_err(|error| format!("Failed to read schema.md: {error}"))?;
    if content.trim().is_empty() {
        return Err("schema.md must not be empty".to_string());
    }
    Ok((path, content))
}

fn canonical_project_root(project_path: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_path)
        .canonicalize()
        .map_err(|error| format!("Invalid project path: {error}"))?;
    if !root.is_dir() || !root.join(".llm-wiki").is_dir() {
        return Err("Schema operations require a valid project with .llm-wiki state".to_string());
    }
    Ok(root)
}

fn validate_schema_size(schema: &str) -> Result<(), String> {
    if schema.trim().is_empty() || schema.len() > MAX_SCHEMA_BYTES {
        return Err("Proposed schema must be non-empty and at most 256 KiB".to_string());
    }
    Ok(())
}

fn compile_schema(schema: &str) -> CompiledSchema {
    let mut diagnostics = Vec::new();
    let mut type_dirs = HashMap::new();
    let mut dirs = HashMap::new();
    let mut schema_version = 1_u32;
    let lines = schema.lines().collect::<Vec<_>>();

    if lines.first().is_some_and(|line| line.trim() == "---") {
        for line in lines.iter().skip(1) {
            if line.trim() == "---" { break; }
            if let Some(value) = line.trim().strip_prefix("schemaVersion:") {
                schema_version = value.trim().parse::<u32>().ok().filter(|value| *value > 0).unwrap_or(1);
            }
        }
    }

    let page_types_start = lines.iter().position(|line| {
        let normalized = line.trim().trim_matches('#').trim();
        normalized.eq_ignore_ascii_case("page types")
    });
    if let Some(start) = page_types_start {
        for (index, line) in lines.iter().enumerate().skip(start + 1) {
            if line.trim_start().starts_with('#') { break; }
            let trimmed = line.trim();
            if !trimmed.starts_with('|') { continue; }
            let cells = trimmed.split('|').skip(1).take_while(|value| !value.is_empty()).map(str::trim).collect::<Vec<_>>();
            if cells.len() < 2 || cells[0].eq_ignore_ascii_case("type") || cells[0].chars().all(|ch| ch == '-' || ch == ':') { continue; }
            let (page_type, directory) = (cells[0], cells[1].trim_end_matches('/'));
            if !is_valid_page_type(page_type) {
                diagnostics.push(diag("error", "invalid_type", format!("Invalid page type '{page_type}'."), index + 1));
                continue;
            }
            if directory != "wiki" && !directory.starts_with("wiki/") {
                diagnostics.push(diag("error", "invalid_directory", format!("Page type '{page_type}' must be under wiki/."), index + 1));
                continue;
            }
            if type_dirs.contains_key(page_type) {
                diagnostics.push(diag("error", "duplicate_type", format!("Page type '{page_type}' is declared more than once."), index + 1));
                continue;
            }
            if let Some(existing) = dirs.get(directory) {
                diagnostics.push(diag("warning", "duplicate_directory", format!("Page type '{page_type}' shares '{directory}/' with '{existing}'."), index + 1));
            } else {
                dirs.insert(directory.to_string(), page_type.to_string());
            }
            if matches!(page_type, "index" | "log") {
                diagnostics.push(diag("warning", "reserved_type", format!("Page type '{page_type}' is application-managed."), index + 1));
            }
            type_dirs.insert(page_type.to_string(), directory.to_string());
        }
    }
    if type_dirs.is_empty() {
        diagnostics.push(SchemaDiagnostic { severity: "warning".to_string(), code: "missing_page_types".to_string(), message: "Schema does not define a valid Page Types table; routing validation is disabled.".to_string(), line: None });
    }

    CompiledSchema { schema_version, content_hash: content_hash(schema), type_dirs, diagnostics }
}

pub fn audit_project_schema_for_api(
    project_path: &str,
    schema: &CompiledSchema,
) -> Result<SchemaImpactReport, String> {
    audit_project_schema(project_path, schema)
}

fn audit_project_schema(project_path: &str, schema: &CompiledSchema) -> Result<SchemaImpactReport, String> {
    let root = canonical_project_root(project_path)?;
    let wiki = root.join("wiki");
    let mut pages = Vec::new();
    collect_markdown_pages(&wiki, &wiki, &mut pages)?;
    let total_pages = pages.len();
    let mut affected_pages = Vec::new();
    let truncated = total_pages > MAX_AUDIT_PAGES;
    for path in pages.into_iter().take(MAX_AUDIT_PAGES) {
        let content = match fs::read_to_string(&path) { Ok(content) => content, Err(_) => continue };
        let rel = path.strip_prefix(&root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        if RESERVED_PATHS.contains(&rel.as_str()) { continue; }
        if let Some(issue) = routing_issue(&rel, &content, schema) {
            affected_pages.push(issue);
        }
    }
    Ok(SchemaImpactReport { schema_hash: schema.content_hash.clone(), pages_scanned: total_pages.min(MAX_AUDIT_PAGES), affected_pages, truncated })
}

fn collect_markdown_pages(root: &Path, current: &Path, pages: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = match fs::read_dir(current) { Ok(entries) => entries, Err(error) if current == root => return Err(format!("Failed to scan wiki: {error}")), Err(_) => return Ok(()) };
    for entry in entries.flatten() {
        let path = entry.path();
        let kind = match entry.file_type() { Ok(kind) => kind, Err(_) => continue };
        if kind.is_symlink() { continue; }
        if kind.is_dir() { collect_markdown_pages(root, &path, pages)?; }
        else if kind.is_file() && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")) { pages.push(path); }
    }
    Ok(())
}

fn routing_issue(path: &str, content: &str, schema: &CompiledSchema) -> Option<SchemaImpactPage> {
    let page_type = frontmatter_type(content)?;
    let directory = path.rsplit_once('/').map(|(directory, _)| directory).unwrap_or(".");
    if let Some(expected_dir) = schema.type_dirs.get(page_type) {
        if directory != expected_dir {
            return Some(SchemaImpactPage { path: path.to_string(), code: "type_directory_mismatch".to_string(), message: format!("Page type '{page_type}' must be under '{expected_dir}/'. Current directory: '{directory}'."), expected_dir: Some(expected_dir.clone()), expected_type: None });
        }
    }
    let type_from_path = schema.type_dirs.iter().find_map(|(page_type, expected_dir)| (directory == expected_dir).then(|| page_type));
    if let Some(expected_type) = type_from_path.filter(|expected_type| *expected_type != page_type) {
        return Some(SchemaImpactPage { path: path.to_string(), code: "directory_type_mismatch".to_string(), message: format!("Pages under '{directory}/' must use type '{expected_type}', but found '{page_type}'."), expected_dir: None, expected_type: Some(expected_type.clone()) });
    }
    None
}

fn frontmatter_type(content: &str) -> Option<&str> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" { return None; }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" { break; }
        if let Some(value) = trimmed.strip_prefix("type:") { return Some(value.trim().trim_matches(['\"', '\''])); }
    }
    None
}

fn required_directories(schema: &CompiledSchema) -> Vec<String> {
    let mut dirs = schema.type_dirs.values().cloned().collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>();
    dirs.retain(|directory| directory != "wiki");
    dirs
}

fn safe_wiki_directory(project_path: &str, directory: &str) -> Result<PathBuf, String> {
    if directory != "wiki" && !directory.starts_with("wiki/") { return Err("Schema directory must stay under wiki/".to_string()); }
    let root = canonical_project_root(project_path)?;
    let relative = Path::new(directory);
    if relative.components().any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))) { return Err("Schema directory must be a safe project-relative path".to_string()); }
    Ok(root.join(relative))
}

fn proposal_path(project_path: &str, proposal_id: &str) -> Result<PathBuf, String> {
    if Uuid::parse_str(proposal_id).is_err() { return Err("Invalid schema proposal id".to_string()); }
    Ok(canonical_project_root(project_path)?.join(SCHEMA_DIR).join("proposals").join(format!("{proposal_id}.json")))
}

fn save_proposal(project_path: &str, proposal: &SchemaProposal) -> Result<(), String> {
    let path = proposal_path(project_path, &proposal.id)?;
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    prune_old_proposals(path.parent().expect("proposal parent"))?;
    let json = serde_json::to_string_pretty(proposal).map_err(|error| error.to_string())?;
    atomic_write(&path, &json)
}

fn load_proposal(project_path: &str, proposal_id: &str) -> Result<SchemaProposal, String> {
    let path = proposal_path(project_path, proposal_id)?;
    let raw = fs::read_to_string(path).map_err(|_| "Schema proposal was not found".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "Schema proposal is invalid".to_string())
}

fn save_audit(project_path: &str, audit: &SchemaImpactReport) -> Result<(), String> {
    let root = canonical_project_root(project_path)?;
    let path = root.join(SCHEMA_DIR).join("audits").join(format!("{}.json", chrono::Utc::now().timestamp_millis()));
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    let json = serde_json::to_string_pretty(audit).map_err(|error| error.to_string())?;
    atomic_write(&path, &json)
}

fn prune_old_proposals(directory: &Path) -> Result<(), String> {
    let mut proposals = fs::read_dir(directory).map_err(|error| error.to_string())?.flatten().filter_map(|entry| {
        let modified = entry.metadata().ok()?.modified().ok()?;
        Some((modified, entry.path()))
    }).collect::<Vec<_>>();
    let remove_count = proposals.len().saturating_sub(MAX_PROPOSALS - 1);
    if remove_count == 0 { return Ok(()); }
    proposals.sort_by_key(|(modified, _)| *modified);
    for (_, path) in proposals.into_iter().take(remove_count) { let _ = fs::remove_file(path); }
    Ok(())
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "Target has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".{}.{}.tmp", path.file_name().and_then(|name| name.to_str()).unwrap_or("schema"), Uuid::new_v4()));
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| { let _ = fs::remove_file(&temporary); error.to_string() })
}

fn content_hash(content: &str) -> String { format!("sha256:{:x}", Sha256::digest(content.as_bytes())) }

fn is_valid_page_type(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|ch| ch.is_ascii_alphabetic()) && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn diag(severity: &str, code: &str, message: String, line: usize) -> SchemaDiagnostic {
    SchemaDiagnostic { severity: severity.to_string(), code: code.to_string(), message, line: Some(line) }
}

fn render_diagnostics(diagnostics: &[SchemaDiagnostic]) -> String {
    diagnostics.iter().filter(|item| item.severity == "error").map(|item| item.message.clone()).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> PathBuf {
        let root = std::env::temp_dir().join(format!("llm-wiki-schema-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki/concepts")).unwrap();
        fs::write(root.join("schema.md"), "# Schema\n\n## Page Types\n| Type | Directory |\n| --- | --- |\n| concept | wiki/concepts |\n").unwrap();
        root
    }

    #[test]
    fn proposal_is_bound_to_schema_revision_and_applies_atomically() {
        let root = project();
        let proposed = "---\nschemaVersion: 2\n---\n\n## Page Types\n| Type | Directory |\n| --- | --- |\n| concept | wiki/concepts |\n| person | wiki/people |\n";
        let proposal = create_schema_proposal(root.to_str().unwrap(), "project", "session", proposed.to_string()).unwrap();
        let result = apply_schema_proposal(root.to_str().unwrap(), "project", "session", &proposal.id, &proposal.base_schema_hash).unwrap();
        assert_eq!(result.schema_version, 2);
        assert!(root.join("wiki/people").is_dir());
        assert!(fs::read_to_string(root.join("schema.md")).unwrap().contains("person"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_proposal_cannot_overwrite_external_schema_edit() {
        let root = project();
        let proposal = create_schema_proposal(root.to_str().unwrap(), "project", "session", "## Page Types\n| Type | Directory |\n| --- | --- |\n| concept | wiki/ideas |\n".to_string()).unwrap();
        fs::write(root.join("schema.md"), "# edited externally").unwrap();
        assert!(apply_schema_proposal(root.to_str().unwrap(), "project", "session", &proposal.id, &proposal.base_schema_hash).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
