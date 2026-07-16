import { describe, expect, it } from "vitest"
import { normalizeExternalMcpConfig } from "./external-mcp-config"

describe("external MCP config normalization", () => {
  it("keeps a valid enabled stdio MiniMax server and clamps its limits", () => {
    expect(normalizeExternalMcpConfig({
      enabled: true,
      servers: [{
        id: "minimax_token_plan",
        displayName: "MiniMax Token Plan",
        enabled: true,
        transport: {
          type: "stdio",
          command: "uvx",
          args: ["minimax-coding-plan-mcp", "-y"],
          environment: [{ name: "MINIMAX_API_KEY", value: "secret" }],
        },
        limits: {
          startupTimeoutSeconds: 1,
          toolTimeoutSeconds: 999,
          maxCallsPerRun: 0,
          maxOutputBytes: 1,
        },
      }],
    })).toEqual({
      enabled: true,
      servers: [{
        id: "minimax_token_plan",
        displayName: "MiniMax Token Plan",
        enabled: true,
        templateId: undefined,
        transport: {
          type: "stdio",
          command: "uvx",
          args: ["minimax-coding-plan-mcp", "-y"],
          workingDirectory: undefined,
          environment: [{ name: "MINIMAX_API_KEY", value: "secret" }],
        },
        limits: {
          startupTimeoutSeconds: 5,
          toolTimeoutSeconds: 120,
          maxCallsPerRun: 1,
          maxOutputBytes: 1024,
        },
      }],
    })
  })

  it("drops unsafe server entries and disables an empty configuration", () => {
    expect(normalizeExternalMcpConfig({
      enabled: true,
      servers: [{
        id: "bad id",
        displayName: "Unsafe",
        enabled: true,
        transport: { type: "stdio", command: "", args: [] },
      }],
    })).toEqual({ enabled: false, servers: [] })
  })
})
