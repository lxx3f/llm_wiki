import { describe, expect, it } from "vitest"
import { applyAnnotationDrawerMutex, reconcileRightPanel } from "./app-layout-right-panel"

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

describe("annotation drawer ↔ right pane mutex", () => {
  const none = { rightPanel: "none" as const, ignoredResearchOpenVersion: null }
  const research = { rightPanel: "research" as const, ignoredResearchOpenVersion: null }
  const assistant = { rightPanel: "assistant" as const, ignoredResearchOpenVersion: null }

  it("forces research closed when the drawer opens in chat-view", () => {
    // ChatSessionContent has just set annotationDrawerOpen = "msg_1".
    // The reconciler above would have produced "research" because
    // researchPanelOpen=true, but the mutex override must win so the
    // two right-pane surfaces never appear side-by-side.
    expect(applyAnnotationDrawerMutex(research, "msg_1", "chat"))
      .toEqual({ rightPanel: "none", ignoredResearchOpenVersion: null })
  })

  it("restores research visibility once the drawer closes", () => {
    // Same starting state, but the drawer was closed (null).
    expect(applyAnnotationDrawerMutex(research, null, "chat")).toBe(research)
  })

  it("does not touch the pane when the drawer is open in wiki-view", () => {
    // In wiki-view the drawer lives inside WikiPageAssistant (which
    // IS the right pane). Closing the right pane here would unmount
    // the drawer along with the chat session it depends on.
    expect(applyAnnotationDrawerMutex(research, "msg_1", "wiki")).toBe(research)
    expect(applyAnnotationDrawerMutex(assistant, "msg_1", "wiki")).toBe(assistant)
    expect(applyAnnotationDrawerMutex(none, "msg_1", "wiki")).toBe(none)
  })

  it("does not demote WikiPageAssistant when the drawer opens in chat-view", () => {
    // WikiPageAssistant owns its own ChatSessionContent and the
    // drawer it surfaces stays inside WikiPageAssistant's container.
    // Demoting "assistant" → "none" would unmount the chat session
    // mid-conversation and lose the AbortController / run ownership.
    expect(applyAnnotationDrawerMutex(assistant, "msg_1", "chat")).toBe(assistant)
  })

  it("preserves the user's Research-open intent via the store when the drawer is open", () => {
    // The mutex only changes what AppLayout renders — the
    // `useResearchStore.panelOpen` flag itself is updated by a
    // separate effect so the next reconcile cycle (when the user
    // closes the drawer) re-opens Research automatically without
    // the user having to click the Research button again.
    // This test guards the mutex's invariant that it never touches
    // `panelOpen` directly — only the visible state.
    const before = applyAnnotationDrawerMutex(research, "msg_1", "chat")
    expect(before).toEqual({ rightPanel: "none", ignoredResearchOpenVersion: null })
    // `ignoredResearchOpenVersion` is intentionally null after the
    // override: while the drawer is open, we drop any pending
    // research-open deferral so the next reconcile (after the drawer
    // closes) re-evaluates against fresh `researchPanelOpen` state.
    expect(before.ignoredResearchOpenVersion).toBeNull()
  })

  it("is a no-op when the drawer is closed regardless of active view", () => {
    expect(applyAnnotationDrawerMutex(research, null, "chat")).toBe(research)
    expect(applyAnnotationDrawerMutex(research, null, "wiki")).toBe(research)
    expect(applyAnnotationDrawerMutex(none, null, "chat")).toBe(none)
  })
})

