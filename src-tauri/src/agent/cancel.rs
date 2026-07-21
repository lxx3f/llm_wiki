use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

// Cancellation is shared by Tauri commands and the local HTTP API. Keep the
// registry backend-owned so UI disconnects, API clients, and MCP clients all
// observe the same run cancellation semantics.
#[derive(Debug)]
pub struct AgentCancellationToken {
    cancelled: Arc<AtomicBool>,
    key: String,
    registry: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl AgentCancellationToken {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    pub fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("Agent turn cancelled".to_string())
        } else {
            Ok(())
        }
    }

    pub async fn cancelled(&self) {
        while !self.is_cancelled() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for AgentCancellationToken {
    fn drop(&mut self) {
        // Normal completion calls `finish`, but Drop is the safety net for
        // panics, early returns, and aborted tasks. The remove is idempotent.
        if let Ok(mut tokens) = self.registry.lock() {
            tokens.remove(&self.key);
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct AgentCancellationRegistry {
    tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl AgentCancellationRegistry {
    pub fn start(
        &self,
        project_id: &str,
        session_id: &str,
        run_id: &str,
    ) -> AgentCancellationToken {
        let token = Arc::new(AtomicBool::new(false));
        let key = cancel_key(project_id, session_id, run_id);
        self.tokens
            .lock()
            .unwrap()
            .insert(key.clone(), token.clone());
        AgentCancellationToken {
            cancelled: token,
            key,
            registry: self.tokens.clone(),
        }
    }

    pub fn cancel(&self, project_id: &str, session_id: &str, run_id: Option<&str>) -> bool {
        let key_prefix = format!(
            "{}::{}::",
            normalize_key(project_id),
            normalize_key(session_id)
        );
        let annotation_key_prefix = format!(
            "{}::{}::ann::",
            normalize_key(project_id),
            normalize_key(session_id)
        );
        let token = {
            let tokens = self.tokens.lock().unwrap();
            if let Some(run_id) = run_id {
                tokens
                    .get(&cancel_key(project_id, session_id, run_id))
                    .cloned()
            } else {
                // Session-level cancel targets only main runs. Annotation
                // streams use `start_annotation` with an `ann::` segment in
                // the key, so we filter those out to avoid killing side
                // threads when the user asks to stop the main conversation.
                tokens
                    .iter()
                    .find(|(key, _)| {
                        key.starts_with(&key_prefix) && !key.starts_with(&annotation_key_prefix)
                    })
                    .map(|(_, token)| token.clone())
            }
        };
        let Some(token) = token else {
            return false;
        };
        token.store(true, Ordering::Relaxed);
        true
    }

    pub fn finish(&self, project_id: &str, session_id: &str, run_id: &str) {
        self.tokens
            .lock()
            .unwrap()
            .remove(&cancel_key(project_id, session_id, run_id));
    }

    /// Register a cancellation token scoped to a single annotation stream.
    ///
    /// Annotation keys carry an `ann::` segment so they never collide with
    /// main-conversation run keys, and so the session-level `cancel(...)`
    /// prefix scan can ignore them.
    pub fn start_annotation(
        &self,
        project_id: &str,
        session_id: &str,
        annotation_id: &str,
    ) -> AgentCancellationToken {
        let token = Arc::new(AtomicBool::new(false));
        let key = annotation_key(project_id, session_id, annotation_id);
        self.tokens
            .lock()
            .unwrap()
            .insert(key.clone(), token.clone());
        AgentCancellationToken {
            cancelled: token,
            key,
            registry: self.tokens.clone(),
        }
    }

    /// Cancel a single annotation stream without touching the main
    /// conversation or any other annotation under the same session.
    pub fn cancel_annotation(
        &self,
        project_id: &str,
        session_id: &str,
        annotation_id: &str,
    ) -> bool {
        let key = annotation_key(project_id, session_id, annotation_id);
        let token = self.tokens.lock().unwrap().get(&key).cloned();
        let Some(token) = token else {
            return false;
        };
        token.store(true, Ordering::Relaxed);
        true
    }

    /// Explicitly remove an annotation token from the registry. The token's
    /// `Drop` impl already does this as a safety net, but explicit `finish`
    /// lets the runtime release the slot the moment the turn returns.
    pub fn finish_annotation(
        &self,
        project_id: &str,
        session_id: &str,
        annotation_id: &str,
    ) {
        self.tokens
            .lock()
            .unwrap()
            .remove(&annotation_key(project_id, session_id, annotation_id));
    }
}

fn cancel_key(project_id: &str, session_id: &str, run_id: &str) -> String {
    format!(
        "{}::{}::{}",
        normalize_key(project_id),
        normalize_key(session_id),
        normalize_key(run_id)
    )
}

/// Build the registry key for an annotation-scoped cancellation token.
///
/// The `ann::` segment sits between the session id and the annotation id so
/// annotation keys never collide with main-conversation run keys, and so a
/// session-level `cancel(project, session, None)` prefix scan can skip them.
fn annotation_key(project_id: &str, session_id: &str, annotation_id: &str) -> String {
    format!(
        "{}::{}::ann::{}",
        normalize_key(project_id),
        normalize_key(session_id),
        normalize_key(annotation_id)
    )
}

fn normalize_key(value: &str) -> String {
    value.replace(['\\', '/'], "_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_registry_marks_active_session() {
        let registry = AgentCancellationRegistry::default();
        let token = registry.start("p1", "s1", "r1");
        assert!(!token.is_cancelled());
        assert!(registry.cancel("p1", "s1", Some("r1")));
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancellation_registry_returns_false_for_missing_session() {
        let registry = AgentCancellationRegistry::default();
        assert!(!registry.cancel("p1", "missing", None));
    }

    #[test]
    fn cancellation_registry_isolates_projects_and_runs() {
        let registry = AgentCancellationRegistry::default();
        let p1 = registry.start("p1", "same", "r1");
        let p2 = registry.start("p2", "same", "r1");
        assert!(registry.cancel("p1", "same", Some("r1")));
        assert!(p1.is_cancelled());
        assert!(!p2.is_cancelled());

        let r2 = registry.start("p2", "same", "r2");
        registry.finish("p2", "same", "r1");
        assert!(registry.cancel("p2", "same", Some("r2")));
        assert!(r2.is_cancelled());
    }

    #[test]
    fn cancellation_token_drop_removes_registry_entry() {
        let registry = AgentCancellationRegistry::default();
        {
            let _token = registry.start("p1", "s1", "r1");
            assert!(registry.cancel("p1", "s1", Some("r1")));
        }
        assert!(!registry.cancel("p1", "s1", Some("r1")));
    }

    #[test]
    fn annotation_cancel_does_not_affect_main_run() {
        let registry = AgentCancellationRegistry::default();
        let main = registry.start("p1", "s1", "r1");
        let ann = registry.start_annotation("p1", "s1", "ann_1");
        assert!(!main.is_cancelled());
        assert!(!ann.is_cancelled());
        assert!(registry.cancel_annotation("p1", "s1", "ann_1"));
        assert!(ann.is_cancelled());
        assert!(
            !main.is_cancelled(),
            "main run must survive annotation cancel"
        );
    }

    #[test]
    fn annotation_cancel_does_not_affect_other_annotations() {
        let registry = AgentCancellationRegistry::default();
        let a = registry.start_annotation("p1", "s1", "ann_1");
        let b = registry.start_annotation("p1", "s1", "ann_2");
        assert!(registry.cancel_annotation("p1", "s1", "ann_1"));
        assert!(a.is_cancelled());
        assert!(!b.is_cancelled(), "other annotations must survive");
    }

    #[test]
    fn annotation_cancel_returns_false_for_missing_annotation() {
        let registry = AgentCancellationRegistry::default();
        assert!(!registry.cancel_annotation("p1", "s1", "missing"));
    }

    #[test]
    fn annotation_token_drop_removes_registry_entry() {
        let registry = AgentCancellationRegistry::default();
        {
            let _token = registry.start_annotation("p1", "s1", "ann_1");
            assert!(registry.cancel_annotation("p1", "s1", "ann_1"));
        }
        assert!(!registry.cancel_annotation("p1", "s1", "ann_1"));
    }

    #[test]
    fn cancel_by_session_does_not_match_annotation_tokens() {
        // Cancel-by-session must NOT cancel annotation streams living under the
        // same (project, session) — annotation keys carry the `ann::` segment
        // and the prefix scan in cancel() filters them out.
        let registry = AgentCancellationRegistry::default();
        let main = registry.start("p1", "s1", "r1");
        let ann = registry.start_annotation("p1", "s1", "ann_1");
        // Cancel the session without specifying a run_id.
        assert!(registry.cancel("p1", "s1", None));
        assert!(main.is_cancelled(), "main run is targeted by session cancel");
        assert!(
            !ann.is_cancelled(),
            "annotation must survive session-level cancel"
        );
    }
}
