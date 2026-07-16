"""Minimal MCP stdio fixture for LLM Wiki Agent integration tests.

Implements the small subset of MCP that the Rust client exercises:
initialize, tools/list, tools/call. Exposes a single `echo` tool that
returns whatever was passed in the `text` argument. The fixture is kept
deliberately small so the Agent can validate end-to-end plumbing without
pulling in extra build dependencies.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Dict


def respond(message: Dict[str, Any]) -> Dict[str, Any]:
    method = message.get("method")
    message_id = message.get("id")
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": message_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "fixture", "version": "0.0.1"},
                "capabilities": {},
            },
        }
    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": message_id,
            "result": {
                "tools": [
                    {
                        "name": "echo",
                        "description": "Echo provided text back to the caller.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"text": {"type": "string"}},
                            "required": ["text"],
                        },
                    }
                ],
            },
        }
    if method == "tools/call":
        params = message.get("params", {}) or {}
        arguments = params.get("arguments", {}) or {}
        text = arguments.get("text", "")
        return {
            "jsonrpc": "2.0",
            "id": message_id,
            "result": {
                "content": [
                    {"type": "text", "text": f"echo:{text}"},
                ],
                "isError": False,
            },
        }
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "error": {"code": -32601, "message": f"method not supported: {method}"},
    }


def main() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        sys.stdout.write(json.dumps(respond(message)) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
