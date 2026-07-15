import { afterEach, describe, expect, it } from "vitest"
import { useResearchStore } from "./research-store"

const originalState = useResearchStore.getState()

afterEach(() => useResearchStore.setState(originalState, true))

describe("research panel open version", () => {
  it("advances for both explicit opens and task-created opens", () => {
    const initial = useResearchStore.getState().panelOpenVersion
    useResearchStore.getState().setPanelOpen(true)
    expect(useResearchStore.getState().panelOpenVersion).toBe(initial + 1)
    useResearchStore.getState().addTask("Verify ownership")
    expect(useResearchStore.getState().panelOpenVersion).toBe(initial + 2)
  })
})
