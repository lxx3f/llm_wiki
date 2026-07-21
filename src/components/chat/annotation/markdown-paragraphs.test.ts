// @vitest-environment node
import { describe, expect, it } from "vitest"
import { splitMarkdownParagraphs } from "./markdown-paragraphs"

describe("splitMarkdownParagraphs", () => {
  it("splits on single blank line", () => {
    const input = "First paragraph.\n\nSecond paragraph."
    expect(splitMarkdownParagraphs(input)).toEqual([
      "First paragraph.",
      "Second paragraph.",
    ])
  })

  it("collapses multiple blank lines into one break", () => {
    const input = "First.\n\n\n\nSecond."
    expect(splitMarkdownParagraphs(input)).toEqual(["First.", "Second."])
  })

  it("does not split inside fenced code blocks", () => {
    const input = "Before.\n\n```python\ndef foo():\n    pass\n\n\ndef bar():\n    pass\n```\n\nAfter."
    const paras = splitMarkdownParagraphs(input)
    expect(paras).toHaveLength(3)
    expect(paras[0]).toBe("Before.")
    expect(paras[1]).toContain("def foo()")
    expect(paras[1]).toContain("def bar()")
    expect(paras[1]).toContain("```")
    expect(paras[2]).toBe("After.")
  })

  it("does not split inside mermaid blocks", () => {
    const input = "Some text.\n\n```mermaid\ngraph TD\n    A --> B\n\n    B --> C\n```\n\nMore text."
    const paras = splitMarkdownParagraphs(input)
    expect(paras).toHaveLength(3)
    expect(paras[1]).toContain("graph TD")
    expect(paras[1]).toContain("A --> B")
  })

  it("handles tilde fences", () => {
    const input = "Before.\n\n~~~python\ncode\n\nmore code\n~~~\n\nAfter."
    const paras = splitMarkdownParagraphs(input)
    expect(paras).toHaveLength(3)
    expect(paras[1]).toContain("more code")
  })

  it("does not confuse mismatched fences", () => {
    // ``` inside ~~~ block should not close the block
    const input = "Before.\n\n~~~markdown\n```python\ncode\n```\n\n~~~\n\nAfter."
    const paras = splitMarkdownParagraphs(input)
    expect(paras).toHaveLength(3)
    expect(paras[1]).toContain("```python")
  })

  it("handles CRLF line endings", () => {
    const input = "First.\r\n\r\nSecond."
    expect(splitMarkdownParagraphs(input)).toEqual(["First.", "Second."])
  })

  it("preserves trailing single-paragraph content", () => {
    const input = "Only one."
    expect(splitMarkdownParagraphs(input)).toEqual(["Only one."])
  })
})
