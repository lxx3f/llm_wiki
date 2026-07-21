import { transformImageEmbeds, transformWikilinks } from "@/lib/wikilink-transform"
import { convertLatexToUnicode } from "@/lib/latex-to-unicode"

/**
 * Process chat-message content to create clickable links:
 * - `[[wikilinks]]` → markdown fragment links (`[label](#<encoded-target>)`).
 *   The custom `a` renderer in chat-message.tsx intercepts those and
 *   turns them into a clickable `WikiLink`.
 *
 * We route through `transformWikilinks` (same helper the wiki reader
 * uses) instead of an inline regex so chat and the wiki stay in sync.
 * Previous inline approach emitted `wikilink:…` hrefs, which
 * ReactMarkdown's URL sanitizer strips to `""` — a custom URL scheme
 * with non-ASCII path components is not considered a safe href.
 *
 * Also handles Obsidian image embeds (`![[…]]`), bare LaTeX blocks,
 * and a few Unicode niceties — same rules the wiki reader / raw
 * preview use.
 */
export function processContent(text: string): string {
  let result = text

  // Rewrite Obsidian image embeds (`![[…]]`) into standard markdown
  // FIRST — before the `[[…]]` → wikilink conversion below, which
  // would otherwise mangle the embed target into a broken fragment
  // image. Same rule the wiki reader / raw preview use.
  result = transformImageEmbeds(result)

  // Convert [[wikilinks]] to markdown fragment links BEFORE the
  // LaTeX/Unicode pass so wrapped label text is left untouched
  // (the library escapes any `[` / `]` inside the label).
  result = transformWikilinks(result)

  // Wrap bare \begin{...}...\end{...} blocks with $$ for remark-math
  result = result.replace(
    /(?<!\$\$\s*)(\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\})(?!\s*\$\$)/g,
    (_match, block: string) => `$$\n${block}\n$$`,
  )

  // Only apply Unicode conversion to text outside of math delimiters
  // Split on $$...$$ and $...$ blocks, only convert non-math parts
  const parts = result.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g)
  result = parts
    .map((part) => {
      if (part.startsWith("$")) return part // preserve math
      return convertLatexToUnicode(part)
    })
    .join("")

  return result
}
