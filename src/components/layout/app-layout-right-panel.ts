export type RightPanel = "research" | "assistant" | "none"

export function syncRightPanelWithResearch(
  current: RightPanel,
  researchPanelOpen: boolean,
  isStreaming: boolean,
): RightPanel {
  if (isStreaming && current === "assistant") return "assistant"
  if (researchPanelOpen) return "research"
  return current === "research" ? "none" : current
}
