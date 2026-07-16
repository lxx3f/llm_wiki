//! MCP stdio client support for agent-side external tools.
//!
//! This module deliberately exposes an independent session rather than wiring MCP
//! tools into `AgentRuntime`. Callers own the session lifetime and can later add
//! the returned stable tool names to the agent tool registry without changing the
//! MCP transport contract here.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::process::Stdio;
use std::time::Duration;

use rmcp::{
    model::{CallToolRequestParams, JsonObject, PaginatedRequestParams},
    service::RunningService,
    transport::TokioChildProcess,
    RoleClient, ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::timeout;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_OUTPUT_CHAR_LIMIT: usize = 20_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpRuntimeServerConfig {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    pub timeout_ms: u64,
    pub output_char_limit: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpRuntimeConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub servers: Vec<ExternalMcpRuntimeServerConfig>,
}

impl ExternalMcpRuntimeConfig {
    pub fn from_app_state(value: Option<&Value>) -> Self {
        let Some(value) = value else {
            return Self::default();
        };
        serde_json::from_value(value.clone()).unwrap_or_default()
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled && !self.servers.is_empty()
    }

    pub fn enabled_enabled_servers(&self) -> impl Iterator<Item = &ExternalMcpRuntimeServerConfig> {
        self.servers
            .iter()
            .filter(|server| !server.id.trim().is_empty() && !server.command.trim().is_empty())
    }
}

impl ExternalMcpRuntimeServerConfig {
    pub fn into_runtime_config(self) -> McpStdioClientConfig {
        McpStdioClientConfig {
            id: self.id,
            command: self.command,
            args: self.args,
            env: self.environment,
            timeout_ms: self.timeout_ms,
            output_char_limit: self.output_char_limit,
        }
    }
}

/// Serializable configuration for one local stdio MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioClientConfig {
    /// Stable identifier chosen by the application, used as the stable-name prefix.
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_output_char_limit")]
    pub output_char_limit: usize,
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

fn default_output_char_limit() -> usize {
    DEFAULT_OUTPUT_CHAR_LIMIT
}

/// A tool advertised by an MCP server, mapped to an application-stable name.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDefinition {
    pub name: String,
    pub server_name: String,
    pub description: Option<String>,
    pub input_schema: Value,
}

/// A bounded, display-safe tool result. `output` is JSON for the MCP result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallResult {
    pub output: String,
    pub is_error: bool,
    pub truncated: bool,
}

/// Owns a running MCP client connection and its child process transport.
pub struct McpClientSession {
    service: RunningService<RoleClient, ()>,
    server_id: String,
    timeout: Duration,
    output_char_limit: usize,
    stable_to_remote: HashMap<String, String>,
    tool_definitions: Vec<McpToolDefinition>,
}

impl McpClientSession {
    /// Starts the configured process and completes the rmcp initialize handshake.
    pub async fn start(config: McpStdioClientConfig) -> Result<Self, String> {
        validate_config(&config)?;

        let mut command = tokio::process::Command::new(&config.command);
        command.args(&config.args).envs(&config.env);
        let (transport, _stderr) = TokioChildProcess::builder(command)
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Failed to start MCP server '{}': {error}", config.id))?;

        let request_timeout = Duration::from_millis(config.timeout_ms);
        let service = timeout(request_timeout, ().serve(transport))
            .await
            .map_err(|_| format!("MCP server '{}' initialization timed out", config.id))?
            .map_err(|error| format!("Failed to initialize MCP server '{}': {error}", config.id))?;

        Ok(Self {
            service,
            server_id: config.id,
            timeout: request_timeout,
            output_char_limit: config.output_char_limit,
            stable_to_remote: HashMap::new(),
            tool_definitions: Vec::new(),
        })
    }

    /// Requests the server's tools and creates deterministic names for this session.
    pub async fn list_tools(&mut self) -> Result<Vec<McpToolDefinition>, String> {
        let response = self
            .request(
                self.service
                    .peer()
                    .list_tools(Some(PaginatedRequestParams::default())),
            )
            .await?;

        let mut tools = response.tools;
        tools.sort_by(|left, right| left.name.cmp(&right.name));
        self.stable_to_remote.clear();
        self.tool_definitions.clear();

        let mut definitions = Vec::with_capacity(tools.len());
        let mut seen_stable = HashSet::new();
        for tool in tools {
            let remote_name = tool.name.to_string();
            let stable_name = stable_tool_name(&self.server_id, &remote_name)?;
            if !seen_stable.insert(stable_name.clone()) {
                return Err(format!(
                    "MCP server '{}' has tools that map to the same stable name '{stable_name}'",
                    self.server_id
                ));
            }
            self.stable_to_remote
                .insert(stable_name.clone(), remote_name.clone());
            let definition = McpToolDefinition {
                name: stable_name,
                server_name: self.server_id.clone(),
                description: tool.description.map(|description| description.to_string()),
                input_schema: serde_json::to_value(&tool.input_schema)
                    .map_err(|error| format!("Failed to serialize MCP tool schema: {error}"))?,
            };
            self.tool_definitions.push(definition.clone());
            definitions.push(definition);
        }
        Ok(definitions)
    }

    pub fn snapshot_definitions(&self) -> Vec<McpToolDefinition> {
        self.tool_definitions.clone()
    }

    pub fn lookup_session(&self, stable_name: &str) -> bool {
        self.stable_to_remote.contains_key(stable_name)
    }

    /// Calls a previously discovered stable tool name with a JSON object argument value.
    pub async fn call_tool(
        &self,
        stable_name: &str,
        arguments: Value,
    ) -> Result<McpToolCallResult, String> {
        let remote_name = self.stable_to_remote.get(stable_name).ok_or_else(|| {
            format!("Unknown MCP tool '{stable_name}'. Call list_tools before invoking a tool.")
        })?;
        let arguments = value_to_object(arguments)?;
        let params = CallToolRequestParams::new(remote_name.clone()).with_arguments(arguments);
        let result = self.request(self.service.peer().call_tool(params)).await?;
        let is_error = result.is_error.unwrap_or(false);
        let output = serde_json::to_string(&result)
            .map_err(|error| format!("Failed to serialize MCP tool result: {error}"))?;
        let (output, truncated) = truncate_output(&output, self.output_char_limit);

        Ok(McpToolCallResult {
            output,
            is_error,
            truncated,
        })
    }

    /// Gracefully closes the service, which also closes and reaps the child process.
    pub async fn close(&mut self) -> Result<(), String> {
        timeout(self.timeout, self.service.close())
            .await
            .map_err(|_| "MCP server shutdown timed out".to_string())?
            .map_err(|error| format!("Failed to close MCP server session: {error}"))?;
        Ok(())
    }

    async fn request<T>(
        &self,
        request: impl std::future::Future<Output = Result<T, rmcp::ServiceError>>,
    ) -> Result<T, String> {
        timeout(self.timeout, request)
            .await
            .map_err(|_| "MCP request timed out".to_string())?
            .map_err(|error| format!("MCP request failed: {error}"))
    }
}

fn validate_config(config: &McpStdioClientConfig) -> Result<(), String> {
    if config.id.trim().is_empty() {
        return Err("MCP server id must not be empty".to_string());
    }
    if config.command.trim().is_empty() {
        return Err("MCP server command must not be empty".to_string());
    }
    if config.timeout_ms == 0 {
        return Err("MCP timeoutMs must be greater than zero".to_string());
    }
    if config.output_char_limit == 0 {
        return Err("MCP outputCharLimit must be greater than zero".to_string());
    }
    Ok(())
}

fn value_to_object(value: Value) -> Result<JsonObject, String> {
    match value {
        Value::Object(object) => Ok(object),
        _ => Err("MCP tool arguments must be a JSON object".to_string()),
    }
}

pub fn stable_tool_name(server_id: &str, remote_name: &str) -> Result<String, String> {
    let server_id = normalized_name(server_id);
    let remote_name = normalized_name(remote_name);
    if server_id.is_empty() || remote_name.is_empty() {
        return Err("MCP server and tool names must contain usable characters".to_string());
    }
    Ok(format!("mcp.{server_id}.{remote_name}"))
}

fn normalized_name(value: &str) -> String {
    let normalized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect();
    normalized.trim_matches('_').to_string()
}

fn truncate_output(output: &str, limit: usize) -> (String, bool) {
    if output.chars().count() <= limit {
        return (output.to_string(), false);
    }

    let prefix: String = output.chars().take(limit).collect();
    (format!("{prefix}\n… [MCP output truncated]"), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_deserialize() {
        let config: McpStdioClientConfig = serde_json::from_value(serde_json::json!({
            "id": "demo",
            "command": "demo-mcp"
        }))
        .expect("config should deserialize");

        assert_eq!(config.args, Vec::<String>::new());
        assert_eq!(config.timeout_ms, DEFAULT_TIMEOUT_MS);
        assert_eq!(config.output_char_limit, DEFAULT_OUTPUT_CHAR_LIMIT);
    }

    #[test]
    fn stable_names_are_deterministic_and_normalized() {
        assert_eq!(
            stable_tool_name("My Server", "find/file").unwrap(),
            "mcp.My_Server.find_file"
        );
    }

    #[test]
    fn only_object_arguments_are_accepted() {
        assert!(value_to_object(serde_json::json!({"query": "rust"})).is_ok());
        assert!(value_to_object(serde_json::json!(["rust"])).is_err());
    }

    #[test]
    fn output_truncation_preserves_utf8_boundaries() {
        let (output, truncated) = truncate_output("你好世界", 3);
        assert_eq!(output, "你好世\n… [MCP output truncated]");
        assert!(truncated);
    }

    #[test]
    fn invalid_config_is_rejected_before_spawning() {
        let config = McpStdioClientConfig {
            id: "".to_string(),
            command: "server".to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
            timeout_ms: 1,
            output_char_limit: 1,
        };
        assert_eq!(
            validate_config(&config),
            Err("MCP server id must not be empty".to_string())
        );
    }

    #[tokio::test]
    async fn session_starts_list_tools_and_calls_against_fixture() {
        let Ok(fixture) = FixtureScriptPath::locate() else {
            // Skip silently if a fixture script isn't available in this environment.
            eprintln!("MCP fixture not available; skipping integration test");
            return;
        };
        let config = McpStdioClientConfig {
            id: "fixture".to_string(),
            command: fixture.command().to_string(),
            args: fixture.args(),
            env: BTreeMap::new(),
            timeout_ms: 2_000,
            output_char_limit: 2_000,
        };
        let mut session = McpClientSession::start(config)
            .await
            .expect("session should start against fixture");
        let tools = session.list_tools().await.expect("list_tools succeeds");
        assert!(
            tools.iter().any(|tool| tool.name == "mcp.fixture.echo"),
            "expected fixture to expose mcp.fixture.echo; got {:?}",
            tools.iter().map(|tool| tool.name.clone()).collect::<Vec<_>>()
        );
        let result = session
            .call_tool("mcp.fixture.echo", serde_json::json!({"text": "hello"}))
            .await
            .expect("call_tool succeeds");
        assert!(result.output.contains("hello"));
        assert!(!result.is_error);
        session.close().await.expect("close succeeds");
    }

    #[test]
    fn runtime_config_from_app_state_normalizes_enabled_servers() {
        let value = serde_json::json!({
            "enabled": true,
            "servers": [
                {
                    "id": "demo",
                    "command": "demo-mcp",
                    "args": ["--flag"],
                    "environment": {"TOKEN": "abc"},
                    "timeoutMs": 1500,
                    "outputCharLimit": 1500,
                },
            ],
        });
        let cfg = ExternalMcpRuntimeConfig::from_app_state(Some(&value));
        assert!(cfg.is_enabled());
        let server = cfg
            .enabled_enabled_servers()
            .next()
            .expect("server should be enabled");
        assert_eq!(server.id, "demo");
        assert_eq!(server.command, "demo-mcp");
        assert_eq!(server.environment.get("TOKEN").map(String::as_str), Some("abc"));
    }
}

#[cfg(test)]
struct FixtureScriptPath;

#[cfg(test)]
impl FixtureScriptPath {
    fn locate() -> Result<Self, String> {
        use std::path::PathBuf;
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        path.push("tests");
        path.push("fixtures");
        path.push("mock_mcp_server.py");
        if path.exists() {
            Ok(Self)
        } else {
            Err(format!("missing fixture at {}", path.display()))
        }
    }

    fn command(&self) -> &'static str {
        "python"
    }

    fn args(&self) -> Vec<String> {
        let mut path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        path.push("tests");
        path.push("fixtures");
        path.push("mock_mcp_server.py");
        vec![path.to_string_lossy().into_owned()]
    }
}

pub(crate) fn tests_fixture_path() -> Result<std::path::PathBuf, String> {
    use std::path::PathBuf;
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("tests");
    path.push("fixtures");
    path.push("mock_mcp_server.py");
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("missing fixture at {}", path.display()))
    }
}

pub(crate) fn tests_fixture_script() -> Option<std::path::PathBuf> {
    tests_fixture_path().ok()
}

pub(crate) fn tests_client_config() -> McpStdioClientConfig {
    let script = tests_fixture_script()
        .expect("fixture script path")
        .to_string_lossy()
        .into_owned();
    McpStdioClientConfig {
        id: "fixture".to_string(),
        command: "python".to_string(),
        args: vec![script],
        env: std::collections::BTreeMap::new(),
        timeout_ms: 5_000,
        output_char_limit: 2_000,
    }
}
