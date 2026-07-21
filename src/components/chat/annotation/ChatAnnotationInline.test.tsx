// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, fireEvent } from "@testing-library/react"
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
})
