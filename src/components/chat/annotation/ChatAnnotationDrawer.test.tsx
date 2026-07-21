// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, render, fireEvent } from "@testing-library/react"
import i18n from "@/i18n"
import { ChatAnnotationDrawer } from "./ChatAnnotationDrawer"
import type { DisplayMessage } from "@/stores/chat-store"

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

const message: DisplayMessage = {
  id: "m1",
  role: "assistant",
  content: "Body",
  conversationId: "c1",
  timestamp: 1,
  annotations: [
    {
      id: "ann_1",
      parentMessageId: "m1",
      snippet: "A1 — first snippet that is long enough to test slicing",
      status: "open",
      createdAt: 1,
      thread: [
        { id: "t1", role: "user", content: "Question one", conversationId: "c1", timestamp: 2 },
      ],
    },
    {
      id: "ann_2",
      parentMessageId: "m1",
      snippet: "A2 — second snippet that is also long enough to slice",
      status: "resolved",
      createdAt: 2,
      thread: [],
    },
  ],
}

describe("ChatAnnotationDrawer", () => {
  // Switch the i18n bundle to Chinese so the `t()` calls in
  // `ChatAnnotationDrawer` / `ChatAnnotationInline` resolve to the
  // same Chinese strings the assertions expect (e.g. "旁注",
  // "展开").
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
  // longer auto-cleans.
  afterEach(() => {
    cleanup()
    mockResolve.mockReset()
    mockFlatten.mockReset()
  })

  it("lists all annotations for the message", () => {
    const { getByText } = render(
      <ChatAnnotationDrawer message={message} open onClose={() => {}} />,
    )
    // The list snippet preview is `snippet.slice(0, 30)`, so both
    // prefixes still begin with "A1" / "A2".
    expect(getByText(/A1/)).toBeTruthy()
    expect(getByText(/A2/)).toBeTruthy()
    // Header reflects total count.
    expect(getByText(/旁注 \(2\)/)).toBeTruthy()
  })

  it("selects an annotation and shows its inline view", () => {
    const { getByText, queryByText } = render(
      <ChatAnnotationDrawer message={message} open onClose={() => {}} />,
    )
    // No selection yet → no thread messages rendered.
    expect(queryByText(/Question one/)).toBeNull()
    // Click the first annotation button (its text starts with the
    // snippet preview "A1 …").
    fireEvent.click(getByText(/A1/).closest("button")!)
    // ChatAnnotationInline renders collapsed by default — no thread
    // messages yet. Click its header to expand.
    fireEvent.click(getByText(/展开/).closest("button")!)
    expect(getByText(/Question one/)).toBeTruthy()
  })
})
