import { describe, expect, it, vi } from "vitest"
import {
  cancelPendingWikiWrite,
  confirmPendingWikiWrite,
  isConfirmedWriteForSelectedFile,
  refreshConfirmedWikiWrite,
  summarizeConfirmedWikiWrite,
} from "./wiki-write-confirmation"

const pending = {
  id: "pending-1",
  path: "wiki/page.md",
  content: "# Confirmed content",
  existedBefore: true,
}

describe("Wiki write confirmation", () => {
  it("does not invoke confirmation before an explicit confirm action", () => {
    const confirm = vi.fn()

    expect(confirm).not.toHaveBeenCalled()
  })

  it("confirms with the pending ID and uses staged content for the file activity", async () => {
    const confirm = vi.fn().mockResolvedValue({
      reference: { path: "wiki/page.md" },
      existedBefore: true,
      previousContent: "# Previous content",
    })
    const result = await confirmPendingWikiWrite({
      pendingWrite: pending,
      projectId: "project-1",
      projectPath: "/project",
      sessionId: "session-1",
      confirm,
    })

    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledWith("project-1", "session-1", pending.id)
    expect(result).toEqual({
      path: "/project/wiki/page.md",
      content: pending.content,
      existedBefore: true,
      previousContent: "# Previous content",
    })
  })

  it("preserves confirmed overwrite history for diff display and undo", async () => {
    const confirmed = await confirmPendingWikiWrite({
      pendingWrite: { ...pending, content: "head\nnew\ntail" },
      projectId: "project-1",
      projectPath: "/project",
      sessionId: "session-1",
      confirm: vi.fn().mockResolvedValue({
        reference: { path: "wiki/page.md" },
        existedBefore: true,
        previousContent: "head\nold\ntail",
      }),
    })
    const change = summarizeConfirmedWikiWrite({ ...confirmed, id: pending.id, timestamp: 123 })

    expect(change).toMatchObject({
      id: pending.id,
      path: "/project/wiki/page.md",
      tool: "wiki.write",
      operation: "modified",
      additions: 1,
      deletions: 1,
      diff: "@@ -2,1 +2,1 @@\n-old\n+new",
      beforeContent: "head\nold\ntail",
      afterContent: "head\nnew\ntail",
      timestamp: 123,
    })
  })

  it("preserves creation rollback snapshots when the backend confirms a new page", () => {
    const change = summarizeConfirmedWikiWrite({
      id: pending.id,
      path: "/project/wiki/new.md",
      content: "new page",
      existedBefore: false,
      previousContent: undefined,
      timestamp: 123,
    })

    expect(change).toMatchObject({
      operation: "created",
      additions: 1,
      deletions: 0,
      beforeContent: null,
      afterContent: "new page",
    })
  })

  it("refreshes a matching open editor using cross-platform normalized paths", async () => {
    const read = vi.fn().mockResolvedValue("fresh file")
    const setFileContent = vi.fn()
    await refreshConfirmedWikiWrite({
      projectPath: "C:/project",
      confirmedPath: "C:/project/wiki/page.md",
      refresh: vi.fn().mockResolvedValue(undefined),
      getSelectedFile: () => "C:\\project\\wiki\\page.md",
      read,
      setFileContent,
    })

    expect(read).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledWith("C:/project/wiki/page.md")
    expect(setFileContent).toHaveBeenCalledOnce()
    expect(setFileContent).toHaveBeenCalledWith("fresh file")
  })

  it("does not read or overwrite the editor when the selected file changes during refresh", async () => {
    let selectedFile: string | null = "/project/wiki/page.md"
    const refresh = vi.fn().mockImplementation(async () => {
      selectedFile = "/project/wiki/other.md"
    })
    const read = vi.fn()
    const setFileContent = vi.fn()

    await refreshConfirmedWikiWrite({
      projectPath: "/project",
      confirmedPath: "/project/wiki/page.md",
      refresh,
      getSelectedFile: () => selectedFile,
      read,
      setFileContent,
    })

    expect(refresh).toHaveBeenCalledWith("/project", { bumpDataVersion: true })
    expect(read).not.toHaveBeenCalled()
    expect(setFileContent).not.toHaveBeenCalled()
  })

  it("does not overwrite the editor when the selected file changes while reading", async () => {
    let selectedFile: string | null = "/project/wiki/page.md"
    const read = vi.fn().mockImplementation(async () => {
      selectedFile = "/project/wiki/other.md"
      return "fresh file"
    })
    const setFileContent = vi.fn()

    await refreshConfirmedWikiWrite({
      projectPath: "/project",
      confirmedPath: "/project/wiki/page.md",
      refresh: vi.fn().mockResolvedValue(undefined),
      getSelectedFile: () => selectedFile,
      read,
      setFileContent,
    })

    expect(read).toHaveBeenCalledOnce()
    expect(setFileContent).not.toHaveBeenCalled()
  })

  it("retains confirmation success when tree refresh fails", async () => {
    const confirmed = await confirmPendingWikiWrite({
      pendingWrite: pending,
      projectId: "project-1",
      projectPath: "/project",
      sessionId: "session-1",
      confirm: vi.fn().mockResolvedValue({ reference: { path: "wiki/page.md" }, existedBefore: true }),
    })
    const onError = vi.fn()

    await expect(refreshConfirmedWikiWrite({
      projectPath: "/project",
      confirmedPath: confirmed.path,
      refresh: vi.fn().mockRejectedValue(new Error("refresh failed")),
      getSelectedFile: () => null,
      read: vi.fn(),
      setFileContent: vi.fn(),
      onError,
    })).resolves.toBeUndefined()

    expect(confirmed).toMatchObject({ path: "/project/wiki/page.md", content: pending.content })
    expect(onError).toHaveBeenCalledOnce()
  })

  it("retains confirmation success when refreshing the matching editor fails", async () => {
    const onError = vi.fn()
    await expect(refreshConfirmedWikiWrite({
      projectPath: "/project",
      confirmedPath: "/project/wiki/page.md",
      refresh: vi.fn().mockResolvedValue(undefined),
      getSelectedFile: () => "/project/wiki/page.md",
      read: vi.fn().mockRejectedValue(new Error("read failed")),
      setFileContent: vi.fn(),
      onError,
    })).resolves.toBeUndefined()

    expect(onError).toHaveBeenCalledOnce()
  })

  it("compares confirmation and editor paths across slash conventions", () => {
    expect(isConfirmedWriteForSelectedFile("C:\\project\\wiki\\page.md", "C:/project/wiki/page.md")).toBe(true)
    expect(isConfirmedWriteForSelectedFile("C:/project/wiki/other.md", "C:/project/wiki/page.md")).toBe(false)
  })

  it("cancels locally without invoking confirmation and clears only that pending write", () => {
    const confirm = vi.fn()
    const messages = [
      { id: "message-1", pendingWikiWrite: pending },
      { id: "message-2", pendingWikiWrite: pending },
    ]

    expect(cancelPendingWikiWrite(messages, "message-1")).toEqual([
      { id: "message-1", pendingWikiWrite: undefined },
      { id: "message-2", pendingWikiWrite: pending },
    ])
    expect(confirm).not.toHaveBeenCalled()
  })
})
