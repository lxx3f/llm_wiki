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

/**
 * Apply the right-pane mutex with the annotation drawer that lives
 * inside `ChatSessionContent` (see `chat-session-content.tsx`).
 *
 * The annotation drawer is rendered as a sibling of the chat
 * messages inside `ChatSessionContent`, so when it opens in chat-view
 * the user would otherwise see TWO right-pane surfaces: the drawer
 * (right of the ChatPanel) and the outer Research pane
 * (right of the entire layout). We force the outer pane closed so
 * the right column stays single-column.
 *
 * Scope of the override:
 *   - Only applies when `annotationDrawerOpen !== null` AND
 *     `activeView === "chat"`. In wiki-view the drawer lives inside
 *     WikiPageAssistant (which IS the right pane), so closing the
 *     right pane would unmount the drawer along with the chat
 *     session it depends on. The mutex therefore never fires in
 *     wiki-view.
 *   - Never demotes `"assistant"`: WikiPageAssistant owns its own
 *     drawer and the two are naturally mutually exclusive inside
 *     WikiPageAssistant's container.
 */
export function applyAnnotationDrawerMutex(
  state: RightPanelCoordination,
  annotationDrawerOpen: string | null,
  activeView: string,
): RightPanelCoordination {
  if (annotationDrawerOpen === null) return state
  if (activeView !== "chat") return state
  if (state.rightPanel !== "research") return state
  return { rightPanel: "none", ignoredResearchOpenVersion: null }
}

