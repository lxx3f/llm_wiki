export type RightPanel = "research" | "assistant" | "none"

export interface RightPanelCoordination {
  rightPanel: RightPanel
  ignoredResearchOpenVersion: number | null
}

export function reconcileRightPanel(
  state: RightPanelCoordination,
  researchPanelOpen: boolean,
  researchPanelOpenVersion: number,
  isStreaming: boolean,
): RightPanelCoordination {
  if (isStreaming && state.rightPanel === "assistant") {
    return {
      rightPanel: "assistant",
      ignoredResearchOpenVersion: researchPanelOpen
        ? Math.max(state.ignoredResearchOpenVersion ?? -1, researchPanelOpenVersion)
        : state.ignoredResearchOpenVersion,
    }
  }

  if (
    state.rightPanel === "assistant"
    && state.ignoredResearchOpenVersion !== null
    && researchPanelOpen
    && researchPanelOpenVersion <= state.ignoredResearchOpenVersion
  ) {
    return state
  }

  if (researchPanelOpen) {
    return { rightPanel: "research", ignoredResearchOpenVersion: null }
  }
  return {
    rightPanel: state.rightPanel === "research" ? "none" : state.rightPanel,
    ignoredResearchOpenVersion: state.ignoredResearchOpenVersion,
  }
}
