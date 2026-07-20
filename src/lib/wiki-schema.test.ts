import { describe, expect, it } from "vitest"
import {
  analyzeWikiSchemaImpact,
  compileProjectWikiSchema,
  parseWikiSchemaRouting,
  validateWikiPageRouting,
} from "./wiki-schema"

const SCHEMA = `# Wiki Schema

## Page Types

| Type | Directory | Purpose |
| ---- | --------- | ------- |
| source | wiki/sources/ | Source summaries |
| concept | wiki/concepts/ | Ideas |
| method | wiki/methods/ | Methods |
| overview | wiki/ | Top-level overview |
`

describe("parseWikiSchemaRouting", () => {
  it("extracts type directories from the Page Types table", () => {
    const routing = parseWikiSchemaRouting(SCHEMA)

    expect(routing.typeDirs).toEqual({
      source: "wiki/sources",
      concept: "wiki/concepts",
      method: "wiki/methods",
      overview: "wiki",
    })
  })

  it("ignores unrelated markdown tables outside the Page Types section", () => {
    const routing = parseWikiSchemaRouting([
      "# Wiki Schema",
      "",
      "| Name | Directory |",
      "| ---- | --------- |",
      "| draft | wiki/drafts/ |",
      "",
      "## Page Types",
      "",
      "| Type | Directory | Purpose |",
      "| ---- | --------- | ------- |",
      "| concept | wiki/concepts/ | Ideas |",
      "",
      "## Examples",
      "",
      "| Type | Directory |",
      "| ---- | --------- |",
      "| person | wiki/people/ |",
    ].join("\n"))

    expect(routing.typeDirs).toEqual({
      concept: "wiki/concepts",
    })
  })
  it("reports schema version and malformed Page Types diagnostics", () => {
    const compiled = compileProjectWikiSchema([
      "---",
      "schemaVersion: 3",
      "---",
      "",
      "## Page Types",
      "| Type | Directory |",
      "| --- | --- |",
      "| concept | wiki/concepts |",
      "| concept | wiki/ideas |",
      "| invalid type | outside/wiki |",
    ].join("\n"))

    expect(compiled.schemaVersion).toBe(3)
    expect(compiled.contentHash).toMatch(/^fnv1a-/)
    expect(compiled.typeDirs).toEqual({ concept: "wiki/concepts" })
    expect(compiled.diagnostics.map((item) => item.code)).toEqual([
      "invalid_type",
      "duplicate_type",
    ])
  })

  it("reports missing Page Types instead of silently pretending the schema is valid", () => {
    const compiled = compileProjectWikiSchema("# Notes\n\nNo routing table.")
    expect(compiled.typeDirs).toEqual({})
    expect(compiled.diagnostics).toContainEqual(expect.objectContaining({
      code: "missing_page_types",
      severity: "warning",
    }))
  })
})
describe("validateWikiPageRouting", () => {
  const routing = parseWikiSchemaRouting(SCHEMA)

  it("reports a mismatch between frontmatter type and schema directory", () => {
    const issue = validateWikiPageRouting(
      "wiki/concepts/flash-attention.md",
      [
        "---",
        "type: source",
        "title: Flash Attention",
        "---",
        "",
        "# Flash Attention",
      ].join("\n"),
      routing,
    )

    expect(issue?.message).toContain('type "source" must be under "wiki/sources/"')
  })

  it("allows custom schema types routed by the table", () => {
    expect(
      validateWikiPageRouting(
        "wiki/methods/retrieval.md",
        [
          "---",
          "type: method",
          "title: Retrieval",
          "---",
          "",
          "# Retrieval",
        ].join("\n"),
        routing,
      ),
    ).toBeNull()
  })

  it("does not enforce pages without a parseable type", () => {
    expect(validateWikiPageRouting("wiki/concepts/no-type.md", "# No Type", routing)).toBeNull()
  })

  it("returns structured routing details for an impact report", () => {
    const report = analyzeWikiSchemaImpact([
      {
        path: "wiki/concepts/flash-attention.md",
        content: "---\ntype: source\n---\n# Flash Attention",
      },
      {
        path: "wiki/methods/retrieval.md",
        content: "---\ntype: method\n---\n# Retrieval",
      },
    ], compileProjectWikiSchema(SCHEMA))

    expect(report.pagesScanned).toBe(2)
    expect(report.affectedPages).toEqual([
      expect.objectContaining({
        path: "wiki/concepts/flash-attention.md",
        issue: expect.objectContaining({
          code: "type_directory_mismatch",
          expectedDir: "wiki/sources",
          severity: "error",
        }),
      }),
    ])
  })
})
