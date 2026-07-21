// @vitest-environment jsdom
//
// Tests for `chat-send-annotation-wiki.ts`. The helper builds the
// instruction text the Agent will receive to perform the actual
// `wiki.write_page` call. We keep the helper free of side effects
// (no `tauri.invoke`, no store mutation) so the output is fully
// verifiable from a unit test.
import { describe, expect, it } from "vitest"
import { buildAnnotationWikiSaveInstruction } from "./chat-send-annotation-wiki"
import type { ChatAnnotation } from "./chat-agent-types"

const annotation: ChatAnnotation = {
  id: "ann_1",
  parentMessageId: "m1",
  snippet: "annotation snippet preview text",
  status: "open",
  createdAt: 1,
  thread: [
    { id: "t1", role: "user", content: "Q?", conversationId: "c1", timestamp: 2 },
    { id: "t2", role: "assistant", content: "A.", conversationId: "c1", timestamp: 3 },
  ],
}

describe("buildAnnotationWikiSaveInstruction", () => {
  it("returns a non-empty string", () => {
    const out = buildAnnotationWikiSaveInstruction(
      annotation,
      "---\nannotation_id: ann_1\n---\nbody",
      "wiki/research-notes/x.md",
    )
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(0)
  })

  it("includes the target path inside a backticked span", () => {
    const out = buildAnnotationWikiSaveInstruction(
      annotation,
      "body",
      "wiki/research-notes/x.md",
    )
    expect(out).toContain("`wiki/research-notes/x.md`")
  })

  it("includes the markdown content inside a fenced code block", () => {
    const content = "---\nfoo: bar\n---\nHello"
    const out = buildAnnotationWikiSaveInstruction(annotation, content, "wiki/x.md")
    expect(out).toContain("```markdown")
    expect(out).toContain(content)
  })

  it("tells the agent to call wiki.write_page without modifying content", () => {
    const out = buildAnnotationWikiSaveInstruction(annotation, "body", "wiki/x.md")
    expect(out).toContain("wiki.write_page")
    expect(out.toLowerCase()).toContain("do not modify")
  })

  it("preserves annotation id and parent message id in the instruction", () => {
    const out = buildAnnotationWikiSaveInstruction(annotation, "body", "wiki/x.md")
    // The instruction includes the annotation's id and parent message
    // id so the agent (and any reviewer of the chat log) can trace
    // which annotation produced the write instruction. We assert the
    // presence of the literal ids without depending on the exact
    // formatting so future copy tweaks don't break the contract.
    expect(out).toContain("ann_1")
    expect(out).toContain("m1")
  })
})
