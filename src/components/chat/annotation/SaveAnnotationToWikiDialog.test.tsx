// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, fireEvent } from "@testing-library/react"
import { SaveAnnotationToWikiDialog } from "./SaveAnnotationToWikiDialog"

const mockSave = vi.fn()

vi.mock("./useAnnotationActions", () => ({
  useAnnotationActions: () => ({
    createAnnotation: vi.fn(),
    appendAnnotationMessage: vi.fn(),
    resolveAnnotation: vi.fn(),
    flattenAnnotation: vi.fn(),
    saveAnnotationToWiki: mockSave,
  }),
}))

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
  afterEach(() => {
    cleanup()
    mockSave.mockReset()
  })

  it("renders nothing when open is false", () => {
    const { container } = render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open={false}
        onClose={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("initializes the title input from the annotation snippet (first 40 chars)", () => {
    const { container } = render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
      />,
    )
    const input = container.querySelector("input[type='text'], input:not([type])") as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.value).toBe(annotation.snippet.slice(0, 40))
  })

  it("updates the title when the user types", () => {
    const { container } = render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
      />,
    )
    const input = container.querySelector("input[type='text'], input:not([type])") as HTMLInputElement
    fireEvent.change(input, { target: { value: "My Custom Title" } })
    expect(input.value).toBe("My Custom Title")
  })

  it("renders snippet and thread checkboxes, both toggleable", () => {
    const { container } = render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
      />,
    )
    const checkboxes = container.querySelectorAll("input[type='checkbox']")
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
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={onClose}
      />,
    )
    fireEvent.click(document.body.querySelector("button[data-role='cancel']")!)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("calls saveAnnotationToWiki with targetPath, wikiPath, and markdown when confirm is clicked", () => {
    render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
      />,
    )
    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    expect(mockSave).toHaveBeenCalledTimes(1)
    const [annotationId, targetPath, content] = mockSave.mock.calls[0]
    expect(annotationId).toBe("ann_1")
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

  it("includes thread content when includeThread is checked", () => {
    const { container } = render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
      />,
    )
    const threadCheckbox = container.querySelectorAll("input[type='checkbox']")[1]
    fireEvent.click(threadCheckbox)
    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    const content = mockSave.mock.calls[0][2]
    expect(content).toContain("user")
    expect(content).toContain("Q?")
    expect(content).toContain("assistant")
    expect(content).toContain("A.")
  })

  it("omits the snippet quote when includeSnippet is unchecked", () => {
    const { container } = render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
      />,
    )
    const snippetCheckbox = container.querySelectorAll("input[type='checkbox']")[0]
    fireEvent.click(snippetCheckbox)
    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    const content = mockSave.mock.calls[0][2]
    expect(content).not.toContain("> annotation snippet preview text")
  })

  it("uses a sanitized targetPath when the title contains special characters", () => {
    const { container } = render(
      <SaveAnnotationToWikiDialog
        annotation={annotation}
        open
        onClose={() => {}}
      />,
    )
    const input = container.querySelector("input[type='text'], input:not([type])") as HTMLInputElement
    fireEvent.change(input, { target: { value: "Hello / World?" } })
    fireEvent.click(document.body.querySelector("button[data-role='confirm']")!)
    const targetPath: string = mockSave.mock.calls[0][1]
    // No slashes (path traversal) or query chars in the filename stem
    expect(targetPath).not.toContain("/World")
    expect(targetPath).not.toContain("?")
  })
})
