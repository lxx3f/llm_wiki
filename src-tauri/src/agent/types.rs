use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    Fast,
    Standard,
    Deep,
    LocalFirst,
}

impl Default for AgentMode {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRetrievalMode {
    // Preserve the established single-pass/planner-driven retrieval behavior.
    Standard,
    // Let the Agent iteratively close evidence gaps under a strict retrieval
    // budget and no-progress guard.
    Smart,
}

impl Default for AgentRetrievalMode {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WikiWriteMode {
    Confirm,
    Direct,
}

impl Default for WikiWriteMode {
    fn default() -> Self {
        Self::Confirm
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingWikiWrite {
    pub id: String,
    pub path: String,
    pub content: String,
    pub existed_before: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfirmedWikiWrite {
    pub reference: AgentReference,
    pub existed_before: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolOptions {
    #[serde(default = "default_true")]
    pub wiki: bool,
    #[serde(default)]
    pub web: bool,
    #[serde(default)]
    pub anytxt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub prompt_chars: usize,
    pub completion_chars: usize,
    pub reference_count: usize,
    pub tool_event_count: usize,
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSkillMode {
    // Enabled skills are available as a candidate set. The model may choose
    // which one, if any, fits the request.
    Auto,
    // The user explicitly selected these skills for the turn. The runtime
    // should narrow skill context to this set and tell the model to apply it.
    Explicit,
}

impl Default for AgentSkillMode {
    fn default() -> Self {
        Self::Explicit
    }
}

impl Default for AgentToolOptions {
    fn default() -> Self {
        Self {
            wiki: true,
            web: false,
            anytxt: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatRequest {
    pub message: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub mode: AgentMode,
    #[serde(default)]
    pub retrieval_mode: AgentRetrievalMode,
    #[serde(default)]
    pub wiki_write_mode: WikiWriteMode,
    #[serde(default)]
    pub tools: AgentToolOptions,
    #[serde(default)]
    pub top_k: Option<usize>,
    #[serde(default)]
    pub include_content: Option<bool>,
    #[serde(default)]
    pub history: Vec<AgentConversationMessage>,
    // UI/API callers set this when they intentionally supplied the history
    // field, including an empty array for a brand-new conversation. Without
    // this guard the Tauri command cannot distinguish "no history sent" from
    // "explicitly empty history" and may hydrate stale persisted session
    // messages into a new chat.
    #[serde(default)]
    pub history_explicit: bool,
    #[serde(default)]
    pub skills: Vec<String>,
    // Explicit project-relative files selected by the user in the chat
    // composer. The context loader re-validates project containment and applies
    // strict count/character budgets; callers cannot use this as an arbitrary
    // filesystem read channel.
    #[serde(default)]
    pub context_files: Vec<String>,
    #[serde(default)]
    pub skill_mode: AgentSkillMode,
    // Security boundary: these commands must come from an explicit trusted
    // user approval flow, never from model output, persisted chat content, or
    // skill instructions. Runtime approval uses an exact trimmed string match.
    #[serde(default)]
    pub approved_shell_commands: Vec<String>,
    // Optional command replayed from a prior approval prompt. This must still
    // appear in approved_shell_commands before the runtime will execute it.
    #[serde(default)]
    pub shell_command: Option<String>,
    #[serde(default)]
    pub images: Vec<AgentImage>,
    /// Optional annotation follow-up context. When present, the chat request is
    /// a follow-up turn on a side-thread annotation (snippet + parent message
    /// + prior thread turns) rather than a fresh main-conversation message.
    #[serde(default)]
    pub annotation: Option<AnnotationContext>,
    #[serde(default)]
    pub stream: Option<bool>,
    #[serde(default = "default_true")]
    pub persist_session: bool,
    // When true, the runtime raises its per-mode iteration cap to a very
    // generous upper bound so long-running tasks (e.g. multi-page wiki
    // drafts over many tool calls) can finish without manual
    // "continue" prompts. The Stream idle timeout and the Stop button
    // still bound the run, so this is safe to enable by default for
    // power users — but defaults to false so non-power users keep the
    // predictable budget from a misbehaving model.
    #[serde(default)]
    pub allow_unlimited_iterations: bool,
}

impl Default for AgentChatRequest {
    fn default() -> Self {
        Self {
            message: String::new(),
            session_id: None,
            run_id: None,
            mode: AgentMode::default(),
            retrieval_mode: AgentRetrievalMode::default(),
            wiki_write_mode: WikiWriteMode::default(),
            tools: AgentToolOptions::default(),
            top_k: None,
            include_content: None,
            history: Vec::new(),
            history_explicit: false,
            skills: Vec::new(),
            context_files: Vec::new(),
            skill_mode: AgentSkillMode::default(),
            approved_shell_commands: Vec::new(),
            shell_command: None,
            images: Vec::new(),
            annotation: None,
            stream: None,
            persist_session: true,
            allow_unlimited_iterations: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentImage {
    pub media_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentReference {
    pub title: String,
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge_context: Option<AgentKnowledgeContext>,
}

/// Lightweight graph and provenance briefing attached to wiki retrievals.
/// Keep this bounded: the complete page body is already available through the
/// read/search result and duplicating an unbounded graph would waste context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentKnowledgeContext {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related_to: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outgoing_links: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub backlinks: Vec<String>,
    pub link_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<AgentVersionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentVersionSummary {
    pub timestamp: i64,
    pub author: String,
    pub tool: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolEvent {
    pub tool: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserInputOption {
    pub label: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserInputField {
    pub id: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<AgentUserInputOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserInputRequest {
    pub request_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub fields: Vec<AgentUserInputField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatResponse {
    pub ok: bool,
    pub project_id: String,
    pub session_id: String,
    pub mode: AgentMode,
    pub message: String,
    pub references: Vec<AgentReference>,
    pub tool_events: Vec<AgentToolEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<super::events::AgentEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_input_request: Option<AgentUserInputRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_wiki_write: Option<PendingWikiWrite>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<AgentUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationMessage {
    pub role: String,
    pub content: String,
}

/// Status machine for a side-thread annotation (open → resolved → flattened).
///
/// Mirrors the TypeScript `AnnotationStatus` literal in `src/lib/chat-agent-types.ts`.
/// Serialized as lowercase strings so the JSON contract matches the UI shape.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationStatus {
    Open,
    Resolved,
    Flattened,
}

/// A single displayed turn inside an annotation thread.
///
/// Task 3.1 only carries the thread through the serde contract; the follow-up
/// tasks (3.3+) that actually format the thread reference this struct by name
/// (`crate::agent::types::DisplayMessage`). Keeping it self-contained here
/// avoids dragging `commands::chat_types` into `agent::types` before the wider
/// message-shape unification lands.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DisplayMessage {
    pub role: String,
    pub content: String,
}

/// Context passed to the Agent when an annotation follow-up is submitted.
///
/// Bundles the snippet anchor, the parent message body the snippet was taken
/// from, and the prior turns of the annotation thread so the Agent can answer
/// the user's follow-up without re-reading the whole main conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationContext {
    pub annotation_id: String,
    pub parent_message_id: String,
    pub parent_message_content: String,
    pub snippet: String,
    pub thread: Vec<DisplayMessage>,
    pub status: AnnotationStatus,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_request_accepts_camelcase_api_shape_with_defaults() {
        let req: AgentChatRequest = serde_json::from_value(serde_json::json!({
            "message": "hello",
            "sessionId": "s1",
            "topK": 7,
            "contextFiles": ["wiki/page.md"]
        }))
        .unwrap();

        assert_eq!(req.message, "hello");
        assert_eq!(req.session_id.as_deref(), Some("s1"));
        assert!(req.run_id.is_none());
        assert_eq!(req.mode, AgentMode::Standard);
        assert_eq!(req.retrieval_mode, AgentRetrievalMode::Standard);
        assert_eq!(req.top_k, Some(7));
        assert_eq!(req.context_files, vec!["wiki/page.md".to_string()]);
        assert_eq!(req.skill_mode, AgentSkillMode::Explicit);
        assert!(req.tools.wiki);
        assert!(!req.tools.web);
        assert!(!req.tools.anytxt);
        assert!(req.persist_session);
    }

    #[test]
    fn chat_request_accepts_tool_overrides() {
        let req: AgentChatRequest = serde_json::from_value(serde_json::json!({
            "message": "hello",
            "mode": "local_first",
            "retrievalMode": "smart",
            "tools": {
                "wiki": false,
                "web": true,
                "anytxt": true
            }
        }))
        .unwrap();

        assert_eq!(req.mode, AgentMode::LocalFirst);
        assert_eq!(req.retrieval_mode, AgentRetrievalMode::Smart);
        assert!(!req.tools.wiki);
        assert!(req.tools.web);
        assert!(req.tools.anytxt);
        assert!(req.images.is_empty());
    }

    #[test]
    fn chat_request_accepts_explicit_empty_history_marker() {
        let req: AgentChatRequest = serde_json::from_value(serde_json::json!({
            "message": "hello",
            "history": [],
            "historyExplicit": true
        }))
        .unwrap();

        assert!(req.history.is_empty());
        assert!(req.history_explicit);
    }

    #[test]
    fn chat_request_accepts_auto_skill_mode() {
        let req: AgentChatRequest = serde_json::from_value(serde_json::json!({
            "message": "hello",
            "skills": ["reviewer"],
            "skillMode": "auto"
        }))
        .unwrap();

        assert_eq!(req.skills, vec!["reviewer".to_string()]);
        assert_eq!(req.skill_mode, AgentSkillMode::Auto);
    }

    #[test]
    fn annotation_status_serializes_lowercase() {
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
            thread: vec![DisplayMessage {
                role: "user".into(),
                content: "follow-up".into(),
            }],
            status: AnnotationStatus::Open,
        };
        let json = serde_json::to_string(&ctx).unwrap();
        assert!(json.contains("\"thread\":[{\"role\":\"user\",\"content\":\"follow-up\"}]"));
        let restored: AnnotationContext = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.annotation_id, "ann_1");
        assert_eq!(restored.snippet, "snippet");
        assert_eq!(restored.thread.len(), 1);
        assert_eq!(restored.thread[0].content, "follow-up");
    }

    #[test]
    fn chat_request_accepts_annotation_context() {
        let req = AgentChatRequest {
            message: "Q".into(),
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
        assert!(req.annotation.is_some());
    }

    #[test]
    fn chat_request_default_has_no_annotation() {
        let req = AgentChatRequest::default();
        assert!(req.annotation.is_none());
    }
}
