use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use uuid::Uuid;

use super::types::PendingWikiWrite;

#[derive(Debug, Clone)]
pub(crate) struct StoredPendingWikiWrite {
    pub project_id: String,
    pub session_id: String,
    pub path: String,
    pub content: String,
    created_at: Instant,
}

#[derive(Debug, Clone)]
pub struct PendingWikiWriteStore {
    entries: Arc<Mutex<HashMap<String, StoredPendingWikiWrite>>>,
    ttl: Duration,
}

impl Default for PendingWikiWriteStore {
    fn default() -> Self {
        Self::new(Duration::from_secs(10 * 60))
    }
}

impl PendingWikiWriteStore {
    fn new(ttl: Duration) -> Self {
        Self { entries: Arc::new(Mutex::new(HashMap::new())), ttl }
    }

    #[cfg(test)]
    pub fn new_for_test(ttl: Duration) -> Self {
        Self::new(ttl)
    }

    pub fn insert(
        &self,
        project_id: impl Into<String>,
        session_id: impl Into<String>,
        path: impl Into<String>,
        content: impl Into<String>,
    ) -> PendingWikiWrite {
        let mut entries = self.entries.lock().expect("pending wiki write mutex poisoned");
        Self::purge_expired(&mut entries, self.ttl);
        if entries.len() >= 64 {
            if let Some(oldest_id) = entries.iter().min_by_key(|(_, entry)| entry.created_at).map(|(id, _)| id.clone()) {
                entries.remove(&oldest_id);
            }
        }
        let id = Uuid::new_v4().to_string();
        let path = path.into();
        let content = content.into();
        entries.insert(id.clone(), StoredPendingWikiWrite {
            project_id: project_id.into(),
            session_id: session_id.into(),
            path: path.clone(),
            content: content.clone(),
            created_at: Instant::now(),
        });
        PendingWikiWrite { id, path, content, existed_before: true }
    }

    pub fn take(&self, project_id: &str, session_id: &str, pending_write_id: &str) -> Result<StoredPendingWikiWrite, String> {
        let mut entries = self.entries.lock().expect("pending wiki write mutex poisoned");
        Self::purge_expired(&mut entries, self.ttl);
        let matches = entries.get(pending_write_id).is_some_and(|entry| entry.project_id == project_id && entry.session_id == session_id);
        if !matches {
            return Err("Pending wiki write was not found for this project and session".to_string());
        }
        entries.remove(pending_write_id).ok_or_else(|| "Pending wiki write was not found for this project and session".to_string())
    }

    fn purge_expired(entries: &mut HashMap<String, StoredPendingWikiWrite>, ttl: Duration) {
        let now = Instant::now();
        entries.retain(|_, entry| now.duration_since(entry.created_at) <= ttl);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;
    use super::*;

    #[test]
    fn pending_write_is_single_use_and_bound_to_project_and_session() {
        let store = PendingWikiWriteStore::new_for_test(Duration::from_secs(60));
        let pending = store.insert("p1", "s1", "wiki/a.md", "# revised");
        assert!(store.take("p1", "s2", &pending.id).is_err());
        let taken = store.take("p1", "s1", &pending.id).unwrap();
        assert_eq!(taken.path, "wiki/a.md");
        assert!(store.take("p1", "s1", &pending.id).is_err());
    }
}
