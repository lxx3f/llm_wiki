import { useMemo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import { AlertTriangle, ExternalLink } from "lucide-react"
import { useTranslation } from "react-i18next"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  collectWikilinkRefs,
  transformImageEmbeds,
  transformWikilinks,
} from "@/lib/wikilink-transform"
import { resolveRelatedSlug } from "@/lib/wiki-page-resolver"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import { normalizePath } from "@/lib/path-utils"
import { detectLanguage } from "@/lib/detect-language"
import { getHtmlLang, getTextDirection } from "@/lib/language-metadata"
import { useWikiStore } from "@/stores/wiki-store"
import { MermaidDiagram, unwrapMermaidPre } from "@/components/mermaid-diagram"

interface WikiReaderProps {
  body: string
  /** Original, untransformed Markdown body used for DOM-to-source mapping. */
  sourceBody?: string
  /** Character offset where sourceBody begins in the full Markdown file. */
  sourceOffset?: number
  /**
   * Absolute path of the markdown file being rendered. Used to
   * resolve relative image references against the file's own
   * directory (Obsidian-style), so e.g. `../assets/x.png` works.
   * Optional — when omitted, image paths fall back to wiki-root
   * resolution.
   */
  filePath?: string
}

/**
 * Read-only render of a wiki page body. Distinct from WikiEditor
 * (Milkdown WYSIWYG) because Milkdown round-trips the markdown
 * through prosemirror — applying our wikilink → markdown-link
 * pre-processing there would mean the user's saves overwrite the
 * original `[[…]]` source with `[label](#slug)`. Here, since we
 * never serialize back to disk, transforming for display is safe.
 *
 * Wikilink anchor clicks are intercepted: `#slug` is resolved
 * against the project's wiki tree and routed to the wiki preview,
 * giving the user single-click navigation between pages.
 */
export function WikiReader({ body, sourceBody, sourceOffset = 0, filePath }: WikiReaderProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const projectPathIndex = useWikiStore((s) => s.projectPathIndex)
  const openPathInPreview = useWikiStore((s) => s.openPathInPreview)

  // Image embeds (`![[…]]`) must be rewritten BEFORE the generic
  // wikilink pass, otherwise the embed target gets mangled into a
  // `#fragment` link.
  const transformed = useMemo(
    () => transformWikilinks(transformImageEmbeds(body)),
    [body],
  )
  const renderLanguage = detectLanguage(body)
  const direction = getTextDirection(renderLanguage)
  const htmlLang = getHtmlLang(renderLanguage)
  const projectPath = project ? normalizePath(project.path) : null
  const wikiRoot = projectPath ? `${projectPath}/wiki` : null

  // Set of wikilink slugs (raw targets, NOT encodeURIComponent-ed)
  // that the project path index can't resolve. Rendered links use
  // this to switch into "missing" style (line-through + AlertTriangle)
  // before the user clicks and gets a silent no-op. Recomputes when
  // the body or the project's path index changes.
  const missingSlugs = useMemo(() => {
    if (!wikiRoot) return new Set<string>()
    const refs = collectWikilinkRefs(body)
    if (refs.length === 0) return new Set<string>()
    const missing = new Set<string>()
    for (const { slug } of refs) {
      if (!resolveRelatedSlug(projectPathIndex, slug, wikiRoot)) {
        missing.add(slug)
      }
    }
    return missing
  }, [body, projectPathIndex, wikiRoot])
  const sourceLineStarts = useMemo(() => {
    if (sourceBody === undefined) return null
    const starts = [0]
    for (let index = 0; index < sourceBody.length; index += 1) {
      if (sourceBody.charCodeAt(index) === 10) starts.push(index + 1)
    }
    return starts
  }, [sourceBody])

  const sourceAttrs = (node: unknown): Record<string, number> => {
    if (!sourceLineStarts) return {}
    const position = (node as { position?: { start?: { line?: number }; end?: { line?: number } } } | undefined)?.position
    const startLine = position?.start?.line
    const endLine = position?.end?.line
    if (!startLine || !endLine) return {}
    const start = sourceLineStarts[startLine - 1]
    const end = sourceLineStarts[endLine] ?? sourceBody?.length
    if (start === undefined || end === undefined) return {}
    return { "data-source-start": sourceOffset + start, "data-source-end": sourceOffset + end }
  }
  // Directory of the file being rendered (project-absolute), so
  // relative image srcs resolve against it like Obsidian does.
  const currentFileDir = useMemo(() => {
    if (!filePath) return null
    const norm = normalizePath(filePath)
    const dir = norm.slice(0, norm.lastIndexOf("/"))
    return dir || null
  }, [filePath])

  function handleAnchorClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
    if (!href.startsWith("#")) return
    e.preventDefault()
    if (!wikiRoot) return
    const slug = safeDecodeFragment(href.slice(1))
    const path = resolveRelatedSlug(projectPathIndex, slug, wikiRoot)
    if (path) openPathInPreview(path)
  }

  return (
    <div
      className="prose prose-invert min-w-0 max-w-none"
      dir={direction}
      lang={htmlLang}
      style={{ textAlign: "start" }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ node, children, ...props }) => <p {...sourceAttrs(node)} {...props}>{children}</p>,
          li: ({ node, children, ...props }) => <li {...sourceAttrs(node)} {...props}>{children}</li>,
          blockquote: ({ node, children, ...props }) => <blockquote {...sourceAttrs(node)} {...props}>{children}</blockquote>,
          a: ({ href, children, ...props }) => {
            const h = typeof href === "string" ? href : ""
            const isWikilink = h.startsWith("#")
            // RFC 3986-style scheme detection. Matches `http:`, `https:`,
            // `mailto:`, `ftp:`, `tel:`, `file:`, `data:`, etc. — anything
            // that should leave the app via the system browser / handler
            // instead of being loaded inside the WebView. Relative paths
            // (`./foo`, `../bar`, `/abs`) and pure anchors (`#frag`) are
            // explicitly NOT matched, so they keep their existing
            // behaviour.
            const isExternalUrl = /^[a-z][a-z0-9+.-]*:/i.test(h)
            const slug = isWikilink ? safeDecodeFragment(h.slice(1)) : null
            // Resolve the slug against the path index so unresolved
            // (broken) `[[wikilinks]]` render with the missing-link
            // style instead of looking like working links that click
            // to nothing.
            const isMissing = slug !== null && missingSlugs.has(slug)
            const className = isMissing
              ? "cursor-pointer text-muted-foreground line-through decoration-rose-500/60 underline-offset-2 hover:decoration-rose-500"
              : isWikilink
                ? "cursor-pointer text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                : isExternalUrl
                  // inline-flex + items-baseline keeps the ExternalLink
                  // icon aligned with the link text even when the text
                  // wraps across lines (the gap keeps icon + text on
                  // the same baseline without the underline cutting
                  // through the icon).
                  ? "inline-flex items-baseline gap-1 text-primary underline underline-offset-2 hover:text-primary/80"
                  : "text-primary underline underline-offset-2"
            return (
              <a
                href={h || undefined}
                target={isExternalUrl ? "_blank" : undefined}
                rel={isExternalUrl ? "noopener noreferrer" : undefined}
                // Same routing pattern as settings/about-section.tsx:
                // Tauri 2's WebView doesn't auto-delegate external
                // clicks to the system browser — the opener plugin
                // does. `target="_blank"` + `rel="noopener noreferrer"`
                // stay as a defensive fallback in case `openUrl` rejects.
                onClick={(e) => {
                  if (isWikilink) {
                    handleAnchorClick(e, h)
                    return
                  }
                  if (isExternalUrl) {
                    e.preventDefault()
                    void openUrl(h).catch((err) => {
                      console.error("[wiki-reader] openUrl failed:", err)
                    })
                  }
                }}
                title={
                  isMissing
                    ? t("nav.missingHint", { slug })
                    : isExternalUrl
                      ? t("nav.openExternalHint")
                      : undefined
                }
                data-missing={isMissing ? "true" : undefined}
                data-external={isExternalUrl ? "true" : undefined}
                className={className}
                {...props}
              >
                {isMissing ? (
                  <AlertTriangle
                    className="mr-1 inline h-3 w-3 align-text-bottom text-rose-500/80"
                    aria-hidden
                  />
                ) : null}
                {children}
                {isExternalUrl ? (
                  <ExternalLink
                    className="ml-0.5 inline h-3 w-3 shrink-0 align-baseline text-primary/70"
                    aria-hidden
                  />
                ) : null}
              </a>
            )
          },
          h1: ({ node, children, ...props }) => (
            <h1
              {...sourceAttrs(node)}
              className="mb-4 mt-0 border-b border-border/60 pb-3 text-3xl font-semibold leading-tight tracking-normal text-foreground"
              {...props}
            >
              {children}
            </h1>
          ),
          h2: ({ node, children, ...props }) => (
            <h2
              {...sourceAttrs(node)}
              className="mb-3 mt-8 border-b border-border/40 pb-2 text-2xl font-semibold leading-tight tracking-normal text-foreground"
              {...props}
            >
              {children}
            </h2>
          ),
          h3: ({ node, children, ...props }) => (
            <h3
              {...sourceAttrs(node)}
              className="mb-2 mt-6 text-xl font-semibold leading-snug tracking-normal text-foreground"
              {...props}
            >
              {children}
            </h3>
          ),
          img: ({ src, alt, ...props }) => (
            <img
              src={
                typeof src === "string"
                  ? resolveMarkdownImageSrc(src, projectPath, currentFileDir)
                  : undefined
              }
              data-mdsrc={typeof src === "string" ? src : undefined}
              alt={alt ?? ""}
              className="max-w-full rounded border border-border/40"
              loading="lazy"
              {...props}
            />
          ),
          table: ({ children, ...props }) => (
            <div className="my-2 overflow-x-auto rounded border border-border">
              <table className="w-full border-collapse text-xs" {...props}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children, ...props }) => (
            <thead className="bg-muted" {...props}>
              {children}
            </thead>
          ),
          th: ({ node, children, ...props }) => (
            <th
              {...sourceAttrs(node)}
              className="border border-border/80 bg-muted px-3 py-1.5 text-start font-semibold"
              {...props}
            >
              {children}
            </th>
          ),
          td: ({ node, children, ...props }) => (
            <td {...sourceAttrs(node)} className="border border-border/60 px-3 py-1.5" {...props}>
              {children}
            </td>
          ),
          pre: ({ children, ...props }) => {
            const mermaid = unwrapMermaidPre(children)
            if (mermaid) return <>{mermaid}</>
            return <pre dir="ltr" style={{ textAlign: "left" }} {...props}>{children}</pre>
          },
          code: ({ className, children, ...props }) => {
            const lang = className?.replace("language-", "")
            const codeText = String(children).replace(/\n$/, "")
            if (lang === "mermaid") return <MermaidDiagram code={codeText} />
            return <code dir="ltr" className={className} {...props}>{children}</code>
          },
        }}
      >
        {transformed}
      </ReactMarkdown>
    </div>
  )
}

/**
 * Decode a `#fragment` href back to its raw slug while tolerating
 * malformed escapes (a stray `%` in a hand-written wikilink target
 * would otherwise throw). Falls back to the un-decoded slice when
 * decoding fails so the link still routes — just possibly to a
 * non-existent page, which the missing-style rendering will surface.
 */
function safeDecodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
  }
}
