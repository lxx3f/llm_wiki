import { describe, expect, it } from "vitest"
import { getWikiContextFiles } from "./wiki-page-context"

const root = "C:/wiki-project"

describe("getWikiContextFiles", () => {
  it("keeps the automatic wiki page first and deduplicates manual wiki markdown paths", () => {
    expect(getWikiContextFiles(root, "C:/wiki-project/wiki/current.md", [
      "wiki/current.md",
      "wiki/related.md",
      "wiki/related.md",
      "raw/sources/paper.md",
      "wiki/image.png",
    ])).toEqual(["wiki/current.md", "wiki/related.md"])
  })

  it("rejects paths outside the project wiki directory", () => {
    expect(getWikiContextFiles(root, "C:/other/wiki/nope.md", [
      "../outside.md",
      "wiki/valid.md",
      ".llm-wiki/private.md",
    ])).toEqual(["wiki/valid.md"])
  })
})
