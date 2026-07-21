import { describe, expect, it } from "vitest"
import type { ChatAgentEvent } from "./chat-agent-types"

describe("ChatAgentEvent annotationId", () => {
  it("accepts annotationId in events", () => {
    const e: ChatAgentEvent = {
      stage: "writing",
      annotationId: "ann_1",
    }
    const json = JSON.stringify(e)
    expect(json).toContain("\"annotationId\":\"ann_1\"")
  })

  it("annotationId is optional", () => {
    const e: ChatAgentEvent = { stage: "writing" }
    const json = JSON.stringify(e)
    expect(json).not.toContain("annotationId")
  })
})