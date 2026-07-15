import { describe, expect, it } from "vitest"
import { reconcileRightPanel } from "./app-layout-right-panel"

describe("right panel research coordination", () => {
  it("preserves assistant stream ownership and ignores research opens accumulated during the stream", () => {
    const initial = { rightPanel: "assistant" as const, ignoredResearchOpenVersion: null }
    const whileStreaming = reconcileRightPanel(initial, true, 7, true)
    expect(whileStreaming).toEqual({ rightPanel: "assistant", ignoredResearchOpenVersion: 7 })

    const afterStream = reconcileRightPanel(whileStreaming, true, 7, false)
    expect(afterStream).toEqual(whileStreaming)
  })

  it("switches to research only for a newer explicit research open after the stream", () => {
    const retained = { rightPanel: "assistant" as const, ignoredResearchOpenVersion: 7 }
    expect(reconcileRightPanel(retained, true, 8, false)).toEqual({
      rightPanel: "research",
      ignoredResearchOpenVersion: null,
    })
  })
})
