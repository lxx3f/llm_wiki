import { describe, expect, it, vi } from "vitest"

vi.mock("./chat-session-content", () => ({ ChatSessionContent: () => null }))

import { getPageAssistantContextFiles } from "./wiki-page-assistant"

describe("WikiPageAssistant context", () => {
  it("replaces the automatic page while preserving active conversation manual pages", () => {
    const projectPath = "C:/p"
    const manualContextFiles = ["wiki/related.md"]

    const first = getPageAssistantContextFiles(projectPath, "C:/p/wiki/first.md", manualContextFiles)
    const second = getPageAssistantContextFiles(projectPath, "C:/p/wiki/second.md", manualContextFiles)

    expect(first).toEqual(["wiki/first.md", "wiki/related.md"])
    expect(second).toEqual(["wiki/second.md", "wiki/related.md"])
    expect(manualContextFiles).toEqual(["wiki/related.md"])
  })
})
