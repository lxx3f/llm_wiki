// @vitest-environment jsdom
//
// SaveAnnotationToWikiDialog (Task 6.1+): routes the confirm click through
// an `onSave` callback so the parent owns dispatching the actual
// `wiki.write_page` agent turn (instead of the legacy in-memory
// `saveAnnotationToWiki` chip-only stub). The dialog itself stays a thin
// presentational layer — title / includeSnippet / includeThread toggles,
// target-path sanitization, and markdown-content generation — and only
// emits the prepared payload upward.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react"
import i18n from "@/i18n"
import { SaveAnnotationToWikiDialog } from "./SaveAnnotationToWikiDialog"

const annotation = {
  id: "ann_1",
  parentMessageId: "m1",
  snippet: "annotation snippet preview text",
  status: "open" as const,
  createdAt: 1,
  thread: [
    { id: "t1", role: "user" as const, content: "Q?", conversationId: "c1", timestamp: 2 },
    { id: "t2", role: "assistant" as const, content: "A.", conversationId: "c1", timestamp: 3 },
  ],
}

describe("SaveAnnotationToWikiDialog", () => {
  // The dialog uses `useTranslation()` for every visible string plus
  // its localized error copy. Without initializing i18n here the keys
  // show up verbatim (`annotation.saveToWiki.failure`, etc.), which
  // makes it impossible to assert against the "{{message}}" error
  // placeholder or the retry-button copy. We switch to the Chinese
  // bundle (same as `ChatAnnotationInline.test.tsx`) so we can grep
  // for any Chinese substring without colliding with English keys.
  beforeAll(async () => {
    await i18n.changeLanguage("zh")
  })

  // Defensive cleanup: restore the default English language so the
  // singleton i18next instance doesn't leak the zh switch into
  // other test files when vitest is configured with shared module
  // cache (e.g. `pool: "forks"` with cache).
  afterAll(async () => {
    await i18n.changeLanguage("en")
  })

  afterEach(() => {
    cleanup()
  })

  it("renders nothing when open is false", () => {
    const { container } = render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open={false}
        onClose={() => {}}
        onSave={async () => ({ ok: true })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the modal portal under document.body", () => {
    const { container } = render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
        onSave={async () => ({ ok: true })}
      />,
    )

    expect(container.querySelector("[data-testid='save-annotation-to-wiki-dialog']")).toBeNull()
    expect(document.body.querySelector("[data-testid='save-annotation-to-wiki-dialog']")).toBeTruthy()
  })

  it("closes when the backdrop is clicked or Escape is pressed", () => {
    const onClose = vi.fn()
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={onClose}
        onSave={async () => ({ ok: true })}
      />,
    )

    fireEvent.mouseDown(document.body.querySelector("[data-testid='save-annotation-to-wiki-backdrop']")!)
    fireEvent.keyDown(document, { key: "Escape" })

    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("does not close from the backdrop while saving", () => {
    const onClose = vi.fn()
    const onSave = vi.fn(() => new Promise<never>(() => {}))
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={onClose}
        onSave={onSave}
      />,
    )

    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    fireEvent.mouseDown(document.body.querySelector("[data-testid='save-annotation-to-wiki-backdrop']")!)
    fireEvent.keyDown(document, { key: "Escape" })

    expect(onClose).not.toHaveBeenCalled()
  })

  it("initializes the title input from the annotation snippet (first 40 chars)", () => {
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
        onSave={async () => ({ ok: true })}
      />,
    )
    const input = document.body.querySelector("input[type='text'], input:not([type])") as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.value).toBe(annotation.snippet.slice(0, 40))
  })

  it("updates the title when the user types", () => {
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
        onSave={async () => ({ ok: true })}
      />,
    )
    const input = document.body.querySelector("input[type='text'], input:not([type])") as HTMLInputElement
    fireEvent.change(input, { target: { value: "My Custom Title" } })
    expect(input.value).toBe("My Custom Title")
  })

  it("renders snippet and thread checkboxes, both toggleable", () => {
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
        onSave={async () => ({ ok: true })}
      />,
    )
    const checkboxes = document.body.querySelectorAll("input[type='checkbox']")
    expect(checkboxes.length).toBe(2)
    // Defaults: includeSnippet = true, includeThread = false
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true)
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false)
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[1])
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false)
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true)
  })

  it("calls onClose when cancel is clicked and does not call save", () => {
    const onClose = vi.fn()
    const onSave = vi.fn().mockResolvedValue({ ok: true })
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={onClose}
        onSave={onSave}
      />,
    )
    fireEvent.click(document.body.querySelector("button[data-role='cancel']")!)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  it("calls onSave with annotation + sanitized targetPath + markdown when confirm is clicked", async () => {
    const onClose = vi.fn()
    const onSave = vi.fn().mockResolvedValue({ ok: true })
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={onClose}
        onSave={onSave}
      />,
    )
    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [passedAnnotation, content, targetPath] = onSave.mock.calls[0]
    // The dialog forwards the same annotation reference so the parent
    // can capture thread / parentMessageId without re-deriving them.
    expect(passedAnnotation).toBe(annotation)
    expect(targetPath).toContain("wiki/")
    expect(targetPath.endsWith(".md")).toBe(true)
    // frontmatter
    expect(content).toContain("source: chat-annotation")
    expect(content).toContain("annotation_id: ann_1")
    expect(content).toContain("parent_message_id: m1")
    // Snippet is YAML-quoted so values containing `:` or newlines stay
    // valid frontmatter — assert via the value substring rather than
    // the raw `snippet: <text>` line.
    expect(content).toContain("\"annotation snippet preview text\"")
    // body — default includeSnippet=true, includeThread=false
    expect(content).toContain("> annotation snippet preview text")
  })

  it("closes the dialog after a successful save resolves", async () => {
    const onClose = vi.fn()
    const onSave = vi.fn().mockResolvedValue({ ok: true })
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={onClose}
        onSave={onSave}
      />,
    )
    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it("includes thread content when includeThread is checked", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true })
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
        onSave={onSave}
      />,
    )
    const threadCheckbox = document.body.querySelectorAll("input[type='checkbox']")[1]
    fireEvent.click(threadCheckbox)
    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const content = onSave.mock.calls[0][1]
    expect(content).toContain("user")
    expect(content).toContain("Q?")
    expect(content).toContain("assistant")
    expect(content).toContain("A.")
  })

  it("omits the snippet quote when includeSnippet is unchecked", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true })
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
        onSave={onSave}
      />,
    )
    const snippetCheckbox = document.body.querySelectorAll("input[type='checkbox']")[0]
    fireEvent.click(snippetCheckbox)
    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const content = onSave.mock.calls[0][1]
    expect(content).not.toContain("> annotation snippet preview text")
  })

  it("uses a sanitized targetPath when the title contains special characters", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true })
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
        onSave={onSave}
      />,
    )
    const input = document.body.querySelector("input[type='text'], input:not([type])") as HTMLInputElement
    fireEvent.change(input, { target: { value: "Hello / World?" } })
    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const targetPath: string = onSave.mock.calls[0][2]
    // No slashes (path traversal) or query chars in the filename stem
    expect(targetPath).not.toContain("/World")
    expect(targetPath).not.toContain("?")
  })

  it("surfaces an error message and retry button when onSave rejects", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("network failure"))
    const { findByText } = render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
        onSave={onSave}
      />,
    )
    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    // Dialog should stay open and show an error notice. The localized
    // Chinese copy says "保存旁注失败：..." so we look for the
    // "保存旁注失败" prefix instead of the raw error message
    // (which goes through i18n interpolation and could be split across
    // text nodes).
    const errorNotice = await findByText(/保存旁注失败/)
    expect(errorNotice).toBeTruthy()
    // Confirm-button is replaced by a retry button when an error is
    // surfaced. Assert the retry button is present and labeled with
    // the localized "重试" copy.
    const retryButton = document.body.querySelector("button[data-role='retry']")
    expect(retryButton).toBeTruthy()
    expect(retryButton?.textContent).toMatch(/重试/)
  })

  it("does not auto-close when onSave rejects", async () => {
    const onClose = vi.fn()
    const onSave = vi.fn().mockRejectedValue(new Error("boom"))
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={onClose}
        onSave={onSave}
      />,
    )
    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    // Yield so the rejected promise can settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onClose).not.toHaveBeenCalled()
  })
})
