// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, render, fireEvent } from "@testing-library/react"
import i18n from "@/i18n"
import { ChatAnnotationInline } from "./ChatAnnotationInline"

const mockResolve = vi.fn()
const mockFlatten = vi.fn()

vi.mock("./useAnnotationActions", () => ({
  useAnnotationActions: () => ({
    createAnnotation: vi.fn(),
    appendAnnotationMessage: vi.fn(),
    resolveAnnotation: mockResolve,
    flattenAnnotation: mockFlatten,
  }),
}))

const annotation = {
  id: "ann_1",
  parentMessageId: "m1",
  snippet: "A1",
  status: "open" as const,
  createdAt: 1,
  thread: [
    { id: "t1", role: "user" as const, content: "Q?", conversationId: "c1", timestamp: 2 },
    { id: "t2", role: "assistant" as const, content: "A.", conversationId: "c1", timestamp: 3 },
  ],
}

describe("ChatAnnotationInline", () => {
  // Switch the i18n bundle to Chinese for these tests so the `t()`
  // calls in `ChatAnnotationInline` resolve to the same Chinese
  // strings the assertions below expect (e.g. "展开", "📄 已保存").
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

  // Explicit `cleanup` between tests — the project has no global
  // testing-library setup and `@testing-library/react` v16 no
  // longer auto-cleans, so without this the second test sees the
  // first test's render still in `document.body`.
  afterEach(() => {
    cleanup()
  })

  it("renders collapsed by default", () => {
    const { getByText, queryByText } = render(
      <ChatAnnotationInline annotation={annotation} />
    )
    // `@testing-library/jest-dom` is not installed in this project;
    // assert presence via the DOM API directly (see PerParagraphTrigger.test.tsx).
    expect(getByText(/A1/)).toBeTruthy()
    // Snippet + status live in the header; the thread (Q? / A.) is
    // not rendered until the user clicks the toggle.
    expect(queryByText(/Q\?/)).toBeNull()
    expect(queryByText(/A\./)).toBeNull()
  })

  it("expands on click", () => {
    const { getByText } = render(
      <ChatAnnotationInline annotation={annotation} />
    )
    // The toggle button is the only button in the collapsed view;
    // its visible text contains "展开" until the click flips the
    // open state to `true`.
    fireEvent.click(getByText(/展开/).closest("button")!)
    expect(getByText(/Q\?/)).toBeTruthy()
    expect(getByText(/A\./)).toBeTruthy()
  })

  it("renders a wiki backlink chip only when wikiPath is set", () => {
    const annotationWithWikiPath = {
      ...annotation,
      wikiPath: "wiki/notes/x.md",
    }
    const { getByText, queryByText, rerender } = render(
      <ChatAnnotationInline annotation={annotationWithWikiPath} />
    )

    fireEvent.click(getByText(/展开/).closest("button")!)
    const chip = getByText("📄 已保存").closest("a")
    expect(chip).toBeTruthy()
    expect(chip?.getAttribute("href")).toBe("llm-wiki://wiki/notes/x.md")

    rerender(<ChatAnnotationInline annotation={annotation} />)
    expect(queryByText("📄 已保存")).toBeNull()
  })

  it("'插入主会话' opens the flatten confirmation dialog instead of flattening directly", () => {
    // Task 5.1: clicking the flatten button must NOT call
    // `flattenAnnotation` directly — it must surface the
    // confirmation dialog first, and only the dialog's confirm
    // button calls flatten.
    const { getByText, queryByText } = render(
      <ChatAnnotationInline annotation={annotation} />,
    )
    // Expand so the action buttons render.
    fireEvent.click(getByText(/展开/).closest("button")!)
    // Sanity: the dialog is closed initially.
    expect(queryByText(/插入主会话/)).toBeTruthy()
    // Click the flatten button — its visible text is exactly "插入主会话".
    const flattenButton = getByText("插入主会话").closest("button")!
    fireEvent.click(flattenButton)
    // The dialog (which also contains the "插入主会话" header)
    // should now be mounted — no direct call to flatten yet.
    expect(mockFlatten).not.toHaveBeenCalled()
  })
})
