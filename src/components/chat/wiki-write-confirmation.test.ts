import { describe, expect, it, vi } from "vitest"
import {
  cancelPendingWikiWrite,
  confirmPendingWikiWrite,
  isConfirmedWriteForSelectedFile,
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

  it("confirms with the pending ID, refreshes the tree, and uses staged content for the file activity", async () => {
    const confirm = vi.fn().mockResolvedValue({
      reference: { path: "wiki/page.md" },
      existedBefore: true,
      previousContent: "# Previous content",
    })
    const refresh = vi.fn().mockResolvedValue(undefined)
    const result = await confirmPendingWikiWrite({
      pendingWrite: pending,
      projectId: "project-1",
      projectPath: "/project",
      sessionId: "session-1",
      confirm,
      refresh,
      selectedFile: null,
      read: vi.fn(),
      setFileContent: vi.fn(),
    })

    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledWith("project-1", "session-1", pending.id)
    expect(result).toEqual({
      path: "/project/wiki/page.md",
      content: pending.content,
      existedBefore: true,
    })
    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith("/project", { bumpDataVersion: true })
  })

  it("refreshes a matching open editor using cross-platform normalized paths", async () => {
    const read = vi.fn().mockResolvedValue("fresh file")
    const setFileContent = vi.fn()
    await confirmPendingWikiWrite({
      pendingWrite: pending,
      projectId: "project-1",
      projectPath: "C:/project",
      sessionId: "session-1",
      confirm: vi.fn().mockResolvedValue({
        reference: { path: "wiki/page.md" },
        existedBefore: false,
      }),
      refresh: vi.fn().mockResolvedValue(undefined),
      selectedFile: "C:\\project\\wiki\\page.md",
      read,
      setFileContent,
    })

    expect(read).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledWith("C:/project/wiki/page.md")
    expect(setFileContent).toHaveBeenCalledOnce()
    expect(setFileContent).toHaveBeenCalledWith("fresh file")
  })

  it("does not refresh an editor for a different selected file", async () => {
    const read = vi.fn()
    const setFileContent = vi.fn()
    await confirmPendingWikiWrite({
      pendingWrite: pending,
      projectId: "project-1",
      projectPath: "/project",
      sessionId: "session-1",
      confirm: vi.fn().mockResolvedValue({ reference: { path: "wiki/page.md" }, existedBefore: true }),
      refresh: vi.fn().mockResolvedValue(undefined),
      selectedFile: "/project/wiki/other.md",
      read,
      setFileContent,
    })

    expect(read).not.toHaveBeenCalled()
    expect(setFileContent).not.toHaveBeenCalled()
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
