use serde::{Deserialize, Serialize};

use super::types::{AgentMode, AgentToolOptions};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueryIntent {
    NeedsInternalSearch,
    NeedsExternalSearch,
    NeedsRawSourceSearch,
    NeedsGraph,
    NeedsWrite,
    SimpleConversational,
    Ambiguous,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouterDecision {
    pub intent: QueryIntent,
    // Compatibility field for existing API/debug consumers. The router no
    // longer turns this on from message shape; wiki retrieval is selected by
    // the model planner, with a runtime fallback only when the planner is not
    // available.
    pub should_search_wiki: bool,
    pub should_hint_web: bool,
    pub should_hint_anytxt: bool,
    /// True when the user explicitly asked about a local / installed Python
    /// library or package. Triggers a tool-policy line that nudges the model
    /// planner toward `shell.exec` (python -c "import inspect; ..." / rg)
    /// rather than `web.search`, which would otherwise return generic
    /// documentation instead of the user's installed source.
    pub should_hint_shell: bool,
    pub should_include_sources: bool,
    pub rationale: String,
}

pub fn route_query(message: &str, mode: AgentMode, tools: &AgentToolOptions) -> RouterDecision {
    let lower = message.to_lowercase();
    let trimmed = message.trim();
    let explicit_web = contains_any(
        &lower,
        &[
            "web search",
            "search the web",
            "internet",
            "online",
            "latest",
            "today",
            "新闻",
            "联网",
            "网上",
            "最新",
        ],
    );
    let explicit_raw = contains_any(
        &lower,
        &[
            "raw source",
            "source file",
            "原始资料",
            "原始文件",
            "源文件",
        ],
    );
    let explicit_graph = contains_any(&lower, &["graph", "relationship", "知识图谱", "关系图"]);
    let explicit_write = contains_any(
        &lower,
        &["write to wiki", "create page", "写入", "创建页面"],
    );
    // "本地的X库" / "locally installed X" / site-packages references are a
    // strong signal that the user wants the model to introspect an installed
    // Python package via shell.exec rather than search the public web. Match
    // broadly on the local/installed phrasing; the model planner uses this
    // hint alongside the explicit tool policy line in context.rs.
    let explicit_local_shell = contains_any(
        &lower,
        &[
            "本地",
            "本地代码",
            "本地库",
            "本地源码",
            "本地文件",
            "本地装",
            "本地安装",
            "本地集成",
            "已安装",
            "本地版本",
            "site-packages",
            "sitepackages",
            "site packages",
            "local library",
            "local libraries",
            "local source",
            "local code",
            "local package",
            "local packages",
            "locally installed",
            "installed package",
            "installed library",
            "installed packages",
            "installed libraries",
        ],
    );
    let conversational = trimmed.len() < 32
        && contains_any(
            &lower,
            &["hi", "hello", "thanks", "谢谢", "你好", "好的", "ok"],
        );

    let intent = if explicit_write {
        QueryIntent::NeedsWrite
    } else if explicit_graph {
        QueryIntent::NeedsGraph
    } else if explicit_raw {
        QueryIntent::NeedsRawSourceSearch
    } else if explicit_web {
        QueryIntent::NeedsExternalSearch
    } else if conversational {
        QueryIntent::SimpleConversational
    } else {
        QueryIntent::Ambiguous
    };

    // This router is intentionally conservative. It may label obvious user
    // hints for the final prompt, but it must not infer retrieval from message
    // shape such as length or a question mark. Tool execution is decided by the
    // model planner so capability/meta questions can be answered from the
    // runtime context without an unnecessary wiki search.
    let should_search_wiki = false;

    RouterDecision {
        intent,
        should_search_wiki,
        should_hint_web: tools.web,
        should_hint_anytxt: tools.anytxt,
        should_hint_shell: explicit_local_shell,
        should_include_sources: explicit_raw || matches!(mode, AgentMode::Deep),
        rationale: match intent {
            QueryIntent::NeedsExternalSearch => {
                "User appears to request current/external information.".to_string()
            }
            QueryIntent::SimpleConversational => {
                "Short conversational turn; avoid unnecessary retrieval.".to_string()
            }
            QueryIntent::NeedsRawSourceSearch => {
                "User explicitly referenced raw/source material.".to_string()
            }
            QueryIntent::NeedsGraph => "User asks about graph/relationships.".to_string(),
            QueryIntent::NeedsWrite => "User asks to create or update wiki content.".to_string(),
            QueryIntent::NeedsInternalSearch => {
                "User question likely benefits from project retrieval.".to_string()
            }
            QueryIntent::Ambiguous => {
                "Ambiguous request; let the tool planner decide whether retrieval is useful."
                    .to_string()
            }
        },
    }
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn router_detects_external_search_hint_without_forcing_wiki_on() {
        let decision = route_query(
            "Search the web for latest policy updates",
            AgentMode::Standard,
            &AgentToolOptions {
                wiki: true,
                web: true,
                anytxt: false,
            },
        );
        assert_eq!(decision.intent, QueryIntent::NeedsExternalSearch);
        assert!(!decision.should_search_wiki);
        assert!(decision.should_hint_web);
    }

    #[test]
    fn router_does_not_force_search_from_question_shape() {
        let decision = route_query(
            "你现在有哪些 skill 可以使用？",
            AgentMode::Standard,
            &AgentToolOptions::default(),
        );
        assert_eq!(decision.intent, QueryIntent::Ambiguous);
        assert!(!decision.should_search_wiki);
    }

    #[test]
    fn router_hints_shell_for_local_library_queries() {
        // The exact user-reported case: asking about a local Python library
        // should set should_hint_shell so the model planner uses shell.exec
        // instead of defaulting to web.search.
        let decision = route_query(
            "查一下本地的transformers库是否集成了minimaxm3",
            AgentMode::Standard,
            &AgentToolOptions {
                wiki: true,
                web: true,
                anytxt: false,
            },
        );
        assert!(
            decision.should_hint_shell,
            "router must flag local-library queries for shell.exec"
        );

        // English phrasing.
        let decision_en = route_query(
            "Does the locally installed transformers library integrate minimaxm3?",
            AgentMode::Standard,
            &AgentToolOptions::default(),
        );
        assert!(decision_en.should_hint_shell);

        // site-packages reference.
        let decision_site = route_query(
            "List the classes under site-packages/transformers/models/auto",
            AgentMode::Standard,
            &AgentToolOptions::default(),
        );
        assert!(decision_site.should_hint_shell);
    }

    #[test]
    fn router_does_not_hint_shell_for_generic_questions() {
        // Plain queries about a library without local/installed phrasing
        // should not fire the shell hint — web.search remains the right
        // tool for general documentation lookups.
        let decision = route_query(
            "What does the transformers library do?",
            AgentMode::Standard,
            &AgentToolOptions::default(),
        );
        assert!(!decision.should_hint_shell);

        let decision_zh = route_query(
            "transformers 库是做什么的？",
            AgentMode::Standard,
            &AgentToolOptions::default(),
        );
        assert!(!decision_zh.should_hint_shell);
    }
}
