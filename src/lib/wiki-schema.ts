import { readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"

export type WikiSchemaDiagnosticSeverity = "error" | "warning" | "migration_hint"

export interface WikiSchemaDiagnostic {
  severity: WikiSchemaDiagnosticSeverity
  code: "missing_page_types" | "invalid_type" | "invalid_directory" | "duplicate_type" | "duplicate_directory" | "reserved_type"
  message: string
  line?: number
}

export interface WikiSchemaRouting {
  typeDirs: Record<string, string>
}

export interface CompiledProjectSchema extends WikiSchemaRouting {
  contentHash: string
  schemaVersion: number
  diagnostics: WikiSchemaDiagnostic[]
}

export interface WikiSchemaRoutingIssue {
  message: string
  severity: "error" | "warning"
  code: "type_directory_mismatch" | "directory_type_mismatch"
  expectedDir?: string
  expectedType?: string
}

export interface WikiSchemaImpactPage {
  path: string
  issue: WikiSchemaRoutingIssue
}

export interface WikiSchemaImpactReport {
  schemaHash: string
  pagesScanned: number
  affectedPages: WikiSchemaImpactPage[]
}

interface PageTypeRow {
  type: string
  directory: string
  line: number
}

const RESERVED_AGGREGATE_TYPES = new Set(["index", "log"])

/** Loads the canonical root schema with a read-only legacy fallback. */
export async function loadProjectWikiSchema(
  projectPath: string,
): Promise<{ path: string; content: string; compiled: CompiledProjectSchema } | null> {
  const root = projectPath.replace(/\/+$/, "")
  for (const path of [`${root}/schema.md`, `${root}/wiki/schema.md`]) {
    try {
      const content = await readFile(path)
      if (!content.trim()) continue
      return { path, content, compiled: compileProjectWikiSchema(content) }
    } catch {
      // Try the legacy location only when the canonical file is unavailable.
    }
  }
  return null
}

export async function loadProjectWikiSchemaRouting(
  projectPath: string,
): Promise<WikiSchemaRouting | null> {
  const schema = await loadProjectWikiSchema(projectPath)
  if (!schema || Object.keys(schema.compiled.typeDirs).length === 0) return null
  return schema.compiled
}

/** Backward-compatible routing projection for existing callers. */
export function parseWikiSchemaRouting(markdown: string): WikiSchemaRouting {
  const { typeDirs } = compileProjectWikiSchema(markdown)
  return { typeDirs }
}

/** Compiles the executable Page Types subset of the human-editable schema. */
export function compileProjectWikiSchema(markdown: string): CompiledProjectSchema {
  const diagnostics: WikiSchemaDiagnostic[] = []
  const typeDirs: Record<string, string> = {}
  const rows = pageTypeRows(markdown, diagnostics)

  if (rows.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing_page_types",
      message: 'Schema does not define a valid "Page Types" table; page routing validation is disabled.',
    })
  }

  const dirs = new Map<string, string>()
  for (const row of rows) {
    if (typeDirs[row.type]) {
      diagnostics.push({
        severity: "error",
        code: "duplicate_type",
        line: row.line,
        message: `Page type "${row.type}" is declared more than once.`,
      })
      continue
    }
    const priorType = dirs.get(row.directory)
    if (priorType) {
      diagnostics.push({
        severity: "warning",
        code: "duplicate_directory",
        line: row.line,
        message: `Page type "${row.type}" shares "${row.directory}/" with "${priorType}"; directory-to-type validation is ambiguous.`,
      })
    } else {
      dirs.set(row.directory, row.type)
    }
    if (RESERVED_AGGREGATE_TYPES.has(row.type)) {
      diagnostics.push({
        severity: "warning",
        code: "reserved_type",
        line: row.line,
        message: `Page type "${row.type}" is reserved for application-managed aggregate files.`,
      })
    }
    typeDirs[row.type] = row.directory
  }

  return {
    typeDirs,
    contentHash: stableContentHash(markdown),
    schemaVersion: schemaVersionFromFrontmatter(markdown),
    diagnostics,
  }
}

/**
 * Validates a caller-provided page snapshot. Filesystem walking stays outside
 * this pure helper so a later proposal UI can audit exactly what it previews.
 */
export function analyzeWikiSchemaImpact(
  pages: Iterable<{ path: string; content: string }>,
  schema: WikiSchemaRouting | CompiledProjectSchema,
): WikiSchemaImpactReport {
  const affectedPages: WikiSchemaImpactPage[] = []
  let pagesScanned = 0
  for (const page of pages) {
    pagesScanned += 1
    const issue = validateWikiPageRouting(page.path, page.content, schema)
    if (issue) affectedPages.push({ path: normalizeRelativePath(page.path), issue })
  }
  return {
    schemaHash: "contentHash" in schema ? schema.contentHash : "unversioned",
    pagesScanned,
    affectedPages,
  }
}

export function validateWikiPageRouting(
  relativePath: string,
  content: string,
  routing: WikiSchemaRouting,
): WikiSchemaRoutingIssue | null {
  const parsed = parseFrontmatter(content)
  const type = parsed.frontmatter?.type
  if (typeof type !== "string" || !type.trim()) return null

  const normalizedPath = normalizeRelativePath(relativePath)
  const actualDir = dirname(normalizedPath)
  const expectedDir = routing.typeDirs[type]
  if (expectedDir && actualDir !== expectedDir) {
    return {
      severity: "error",
      code: "type_directory_mismatch",
      expectedDir,
      message: `Page type "${type}" must be under "${expectedDir}/". Current directory: "${actualDir}".`,
    }
  }

  const typeFromPath = inferTypeFromSchemaPath(normalizedPath, routing)
  if (typeFromPath && typeFromPath !== type) {
    return {
      severity: "error",
      code: "directory_type_mismatch",
      expectedType: typeFromPath,
      message: `Pages under "${actualDir}/" must use type "${typeFromPath}", but found "${type}".`,
    }
  }

  return null
}

function pageTypeRows(markdown: string, diagnostics: WikiSchemaDiagnostic[]): PageTypeRow[] {
  const rows: PageTypeRow[] = []
  for (const { text, line } of pageTypesSectionLines(markdown)) {
    if (!text.trim().startsWith("|")) continue
    const cells = text.split("|").slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 2 || /^-+$/.test(cells[0].replace(/:/g, "")) || /^type$/i.test(cells[0])) continue

    const [type, rawDir] = cells
    if (!/^[a-z][a-z0-9_-]*$/i.test(type)) {
      diagnostics.push({ severity: "error", code: "invalid_type", line, message: `Invalid page type "${type}".` })
      continue
    }
    if (rawDir !== "wiki" && !rawDir.startsWith("wiki/")) {
      diagnostics.push({ severity: "error", code: "invalid_directory", line, message: `Page type "${type}" must use "wiki" or a directory below "wiki/", not "${rawDir}".` })
      continue
    }
    rows.push({ type, directory: stripTrailingSlash(rawDir), line })
  }
  return rows
}

function pageTypesSectionLines(markdown: string): Array<{ text: string; line: number }> {
  const lines = markdown.split("\n")
  const start = lines.findIndex((line) => {
    const match = line.trim().match(/^(#{1,6})\s+(.+?)\s*#*$/)
    return !!match && /^page\s+types$/i.test(match[2].trim())
  })
  if (start < 0) return []

  const headingLevel = lines[start].trim().match(/^(#{1,6})/)?.[1].length ?? 6
  const out: Array<{ text: string; line: number }> = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const text = lines[index]
    const heading = text.trim().match(/^(#{1,6})\s+/)
    if (heading && heading[1].length <= headingLevel) break
    out.push({ text, line: index + 1 })
  }
  return out
}

function schemaVersionFromFrontmatter(markdown: string): number {
  const raw = parseFrontmatter(markdown).frontmatter?.schemaVersion
  if (typeof raw !== "string") return 1
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
}

function stableContentHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

function inferTypeFromSchemaPath(relativePath: string, routing: WikiSchemaRouting): string | null {
  const actualDir = dirname(relativePath)
  for (const [type, dir] of Object.entries(routing.typeDirs)) {
    if (actualDir === dir) return type
  }
  return null
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "")
}

function dirname(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath)
  const index = normalized.lastIndexOf("/")
  return index >= 0 ? normalized.slice(0, index) : "."
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}
