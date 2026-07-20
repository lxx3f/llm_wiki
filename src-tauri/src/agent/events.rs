use serde::{Deserialize, Serialize};

use crate::commands::schema::SchemaProposal;

use super::types::{AgentReference, AgentUserInputRequest, PendingWikiWrite};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AgentEvent {
    AgentStart {
        session_id: String,
    },
    TurnStart {
        mode: String,
    },
    ToolStart {
        tool: String,
        input: Option<String>,
    },
    ToolEnd {
        tool: String,
        output: Option<String>,
    },
    ReferenceAdded {
        reference: AgentReference,
    },
    FileChanged {
        path: String,
        tool: String,
        #[serde(rename = "existedBefore")]
        existed_before: bool,
        #[serde(rename = "previousContent", skip_serializing_if = "Option::is_none")]
        previous_content: Option<String>,
    },
    MessageDelta {
        text: String,
    },
    Error {
        message: String,
    },
    UserInputRequired {
        request: AgentUserInputRequest,
    },
    SchemaProposalConfirmationRequired {
        proposal: SchemaProposal,
    },
    WikiWriteConfirmationRequired {
        #[serde(rename = "pendingWrite")]
        pending_write: PendingWikiWrite,
    },
    Done {
        session_id: String,
    },
}

impl AgentEvent {
    pub fn tool_start(tool: impl Into<String>, input: Option<String>) -> Self {
        Self::ToolStart {
            tool: tool.into(),
            input,
        }
    }

    pub fn tool_end(tool: impl Into<String>, output: Option<String>) -> Self {
        Self::ToolEnd {
            tool: tool.into(),
            output,
        }
    }

    /// Remove desktop-process-only data before an event crosses the HTTP API.
    /// Rollback snapshots are needed by the trusted UI for immediate Undo but
    /// are not part of the public Agent event contract.
    pub fn redact_for_external_api(&mut self) {
        if let Self::FileChanged {
            previous_content, ..
        } = self
        {
            *previous_content = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_event_serializes_with_camelcase_tag() {
        let value = serde_json::to_value(AgentEvent::ToolStart {
            tool: "wiki.search".to_string(),
            input: Some("query".to_string()),
        })
        .unwrap();

        assert_eq!(value["type"], "toolStart");
        assert_eq!(value["tool"], "wiki.search");
        assert_eq!(value["input"], "query");
    }

    #[test]
    fn file_changed_event_carries_bounded_rollback_metadata() {
        let value = serde_json::to_value(AgentEvent::FileChanged {
            path: "agent-workspace/report.md".to_string(),
            tool: "workspace.write_file".to_string(),
            existed_before: true,
            previous_content: Some("before".to_string()),
        })
        .unwrap();

        assert_eq!(value["type"], "fileChanged");
        assert_eq!(value["existedBefore"], true);
        assert_eq!(value["previousContent"], "before");
    }

    #[test]
    fn schema_proposal_confirmation_event_serializes_with_camelcase_tag() {
        let proposal = crate::commands::schema::SchemaProposal {
            id: "proposal-1".to_string(),
            project_id: "project-1".to_string(),
            session_id: "session-1".to_string(),
            base_schema_hash: "sha256:before".to_string(),
            proposed_schema: "# Schema".to_string(),
            compiled: crate::commands::schema::CompiledSchema {
                schema_version: 1,
                content_hash: "sha256:after".to_string(),
                type_dirs: Default::default(),
                diagnostics: Vec::new(),
            },
            impact: crate::commands::schema::SchemaImpactReport {
                schema_hash: "sha256:after".to_string(),
                pages_scanned: 0,
                affected_pages: Vec::new(),
                truncated: false,
            },
            required_directories: Vec::new(),
            created_at: 0,
            status: "pending".to_string(),
        };
        let value = serde_json::to_value(AgentEvent::SchemaProposalConfirmationRequired { proposal }).unwrap();
        assert_eq!(value["type"], "schemaProposalConfirmationRequired");
        assert_eq!(value["proposal"]["id"], "proposal-1");
    }

    #[test]
    fn wiki_write_confirmation_event_serializes_with_camelcase_tag() {
        let value = serde_json::to_value(AgentEvent::WikiWriteConfirmationRequired {
            pending_write: PendingWikiWrite {
                id: "pending-1".to_string(),
                path: "wiki/a.md".to_string(),
                content: "after".to_string(),
                existed_before: true,
            },
        })
        .unwrap();

        assert_eq!(value["type"], "wikiWriteConfirmationRequired");
        assert_eq!(value["pendingWrite"]["path"], "wiki/a.md");
    }

    #[test]
    fn external_file_changed_event_omits_rollback_content() {
        let mut event = AgentEvent::FileChanged {
            path: "agent-workspace/report.md".to_string(),
            tool: "workspace.write_file".to_string(),
            existed_before: true,
            previous_content: Some("private previous body".to_string()),
        };
        event.redact_for_external_api();
        let value = serde_json::to_value(event).unwrap();
        assert!(value.get("previousContent").is_none());
    }
}
