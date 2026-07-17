import { useEffect, useCallback, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFile } from "@/commands/fs"
import { getFileCategory, isBinary, isExtractedTextPreviewFile } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { getFileName } from "@/lib/path-utils"
import { searchWiki, tokenizeQuery, type SearchResult } from "@/lib/search"
import { normalizePath } from "@/lib/path-utils"
import { isImeComposing } from "@/lib/keyboard-utils"

const WIKI_SEARCH_DEBOUNCE_MS = 300

export function PreviewPanel() {
  const { t } = useTranslation()
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const previewContentPath = useWikiStore((s) => s.previewContentPath)
  const externalPreview = useWikiStore((s) => s.externalPreview)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const closePreview = useWikiStore((s) => s.closePreview)
  const project = useWikiStore((s) => s.project)
  const openFileInPreview = useWikiStore((s) => s.openFileInPreview)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const pageHistory = useWikiStore((s) => s.pageHistory)
  const historyCursor = useWikiStore((s) => s.historyCursor)
  const goBack = useWikiStore((s) => s.goBack)
  const goForward = useWikiStore((s) => s.goForward)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Snapshot of what was most recently loaded from disk. Milkdown re-emits
  // `markdownUpdated` on initial parse (before the user types anything),
  // which used to trigger an auto-save that could write back a placeholder
  // marker if read_file had returned one for a missing/locked file. We
  // skip save when the incoming markdown equals the last-loaded content.
  const lastLoadedRef = useRef<string>("")
  // Wiki-only quick search: type to filter and open wiki pages without
  // navigating to the dedicated Search view (and let Enter jump there
  // with the same query).
  const [wikiSearchQuery, setWikiSearchQuery] = useState("")
  const [wikiSearchResults, setWikiSearchResults] = useState<SearchResult[]>([])
  const [wikiSearchOpen, setWikiSearchOpen] = useState(false)
  const wikiSearchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wikiSearchToken = useRef(0)

  useEffect(() => {
    if (!selectedFile) {
      setFileContent("")
      lastLoadedRef.current = ""
      return
    }
    if (previewContentPath === selectedFile) {
      lastLoadedRef.current = fileContent
      return
    }
    if (externalPreview?.path === selectedFile) {
      lastLoadedRef.current = fileContent
      return
    }

    const category = getFileCategory(selectedFile)

    if (isBinary(category) && !isExtractedTextPreviewFile(selectedFile)) {
      setFileContent("")
      lastLoadedRef.current = ""
      return
    }

    readFile(selectedFile)
      .then((content) => {
        lastLoadedRef.current = content
        setFileContent(content)
      })
      .catch((err) => {
        lastLoadedRef.current = ""
        setFileContent(`Error loading file: ${err}`)
      })
  }, [selectedFile, previewContentPath, externalPreview, setFileContent])

  const writeNow = useCallback((path: string, markdown: string, syncStore = false) => {
    writeFile(path, markdown)
      .then(() => {
        lastLoadedRef.current = markdown
        if (syncStore) setFileContent(markdown)
      })
      .catch((err) => console.error("Failed to save:", err))
  }, [setFileContent])

  const handleSave = useCallback(
    (markdown: string, options?: { immediate?: boolean }) => {
      if (!selectedFile) return
      // Ignore no-op saves from the editor's initial re-emit. Only write
      // when the user has actually changed the content relative to the
      // last disk read.
      if (markdown === lastLoadedRef.current) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (options?.immediate) {
        setFileContent(markdown)
        writeNow(selectedFile, markdown, true)
        return
      }
      saveTimerRef.current = setTimeout(() => {
        writeNow(selectedFile, markdown, true)
      }, 1000)
    },
    [selectedFile, setFileContent, writeNow]
  )

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (wikiSearchDebounce.current) clearTimeout(wikiSearchDebounce.current)
    }
  }, [])

  const runWikiSearch = useCallback(
    async (query: string) => {
      if (!project) {
        setWikiSearchResults([])
        return
      }
      const trimmed = query.trim()
      if (!trimmed) {
        setWikiSearchResults([])
        return
      }
      try {
        const token = wikiSearchToken.current + 1
        wikiSearchToken.current = token
        const found = await searchWiki(normalizePath(project.path), trimmed)
        if (token !== wikiSearchToken.current) return
        setWikiSearchResults(found.slice(0, 8))
      } catch (err) {
        console.error("Wiki quick search failed:", err)
        setWikiSearchResults([])
      }
    },
    [project],
  )

  useEffect(() => {
    const trimmed = wikiSearchQuery.trim()
    if (!trimmed) {
      if (wikiSearchDebounce.current) {
        clearTimeout(wikiSearchDebounce.current)
        wikiSearchDebounce.current = null
      }
      setWikiSearchResults([])
      return
    }
    if (wikiSearchDebounce.current) {
      clearTimeout(wikiSearchDebounce.current)
    }
    wikiSearchDebounce.current = setTimeout(() => {
      void runWikiSearch(trimmed)
    }, WIKI_SEARCH_DEBOUNCE_MS)
    return () => {
      if (wikiSearchDebounce.current) {
        clearTimeout(wikiSearchDebounce.current)
        wikiSearchDebounce.current = null
      }
    }
  }, [wikiSearchQuery, runWikiSearch])

  const jumpToFullSearch = useCallback(() => {
    const trimmed = wikiSearchQuery.trim()
    if (!trimmed) return
    setWikiSearchOpen(false)
    setActiveView("search")
    setWikiSearchQuery("")
    setWikiSearchResults([])
    // The Search view manages its own state; we just switch view. If you
    // want the query pre-filled too, follow the same `setActiveView` call
    // with a globally-stored pending query in a future refactor.
    void trimmed
  }, [wikiSearchQuery, setActiveView])

  const openResult = useCallback(
    async (path: string) => {
      setWikiSearchOpen(false)
      try {
        const content = await readFile(path)
        openFileInPreview(path, content)
      } catch (err) {
        console.error("Failed to open wiki search result:", err)
      }
    },
    [openFileInPreview],
  )

  if (!selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a file to preview
      </div>
    )
  }

  // Back / Forward shortcuts (Alt+ArrowLeft / Alt+ArrowRight) only
  // while the wiki preview itself is mounted — we attach the listener
  // here rather than at the App level so the keystrokes don't leak
  // into other views (chat, sources, settings). The target guard
  // bails when focus is inside an editable surface so the keys still
  // work in the inline wiki search box and any future in-page
  // contenteditable element.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target?.isContentEditable ?? false)
      ) {
        return
      }
      if (event.key === "ArrowLeft" && historyCursor > 0) {
        event.preventDefault()
        goBack()
      } else if (event.key === "ArrowRight" && historyCursor >= 0
        && historyCursor < pageHistory.length - 1) {
        event.preventDefault()
        goForward()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [historyCursor, pageHistory.length, goBack, goForward])

  const category = getFileCategory(selectedFile)
  const fileName = externalPreview?.path === selectedFile
    ? externalPreview.title
    : getFileName(selectedFile)
  const wikiSearchHighlight = tokenizeQuery(wikiSearchQuery)
  const wikiSearchFallback = wikiSearchQuery.trim().toLowerCase()
  const showWikiSearchResults =
    wikiSearchOpen && wikiSearchQuery.trim().length > 0
  // Drop the currently-open preview from the suggestion list so users
  // don't see it as a "switch to itself" option.
  const wikiSearchSuggestions = wikiSearchResults.filter(
    (r) => normalizePath(r.path) !== normalizePath(selectedFile),
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground" title={selectedFile}>
          {fileName}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={goBack}
            disabled={historyCursor <= 0}
            aria-label={t("nav.back")}
            title={`${t("nav.back")} (Alt+←)`}
            className="shrink-0 rounded p-1 text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-30"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={goForward}
            disabled={historyCursor < 0 || historyCursor >= pageHistory.length - 1}
            aria-label={t("nav.forward")}
            title={`${t("nav.forward")} (Alt+→)`}
            className="shrink-0 rounded p-1 text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-30"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="relative shrink-0">
          <input
            type="text"
            value={wikiSearchQuery}
            onFocus={() => setWikiSearchOpen(true)}
            onBlur={() => {
              // Allow click handlers on suggestions to run before clearing.
              setTimeout(() => setWikiSearchOpen(false), 120)
            }}
            onChange={(event) => {
              setWikiSearchQuery(event.target.value)
              setWikiSearchOpen(true)
            }}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return
              if (event.key === "Enter") {
                event.preventDefault()
                if (wikiSearchSuggestions[0]) {
                  void openResult(wikiSearchSuggestions[0].path)
                  return
                }
                jumpToFullSearch()
              } else if (event.key === "Escape") {
                setWikiSearchQuery("")
                setWikiSearchResults([])
                setWikiSearchOpen(false)
              }
            }}
            placeholder="Search wiki pages…"
            aria-label="Search wiki pages"
            className="w-56 rounded-md border bg-background px-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {showWikiSearchResults && (
            <div className="absolute right-0 z-20 mt-1 w-80 max-h-72 overflow-auto rounded-md border bg-background p-1 text-xs shadow-lg">
              {wikiSearchSuggestions.length === 0 ? (
                <p className="px-2 py-2 text-muted-foreground">
                  {`No results for "${wikiSearchQuery}"`}
                </p>
              ) : (
                <>
                  <ul className="space-y-0.5">
                    {wikiSearchSuggestions.map((result) => (
                      <li key={result.path}>
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void openResult(result.path)}
                          className="block w-full truncate rounded px-2 py-1 text-left text-foreground hover:bg-accent"
                          title={result.path}
                        >
                          <span className="font-medium">
                            {highlightMatch(result.title, wikiSearchHighlight, wikiSearchFallback)}
                          </span>
                          <span className="ml-2 text-[10px] text-muted-foreground">
                            {result.path}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={jumpToFullSearch}
                    className="mt-1 block w-full rounded border-t px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent"
                  >
                    {`Open full search for "${wikiSearchQuery.trim()}"`}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <button
          onClick={closePreview}
          aria-label="Close preview"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 min-w-0 overflow-auto">
        {externalPreview?.path === selectedFile ? (
          <ExternalReferencePreview
            source={externalPreview.source}
            title={externalPreview.title}
            path={externalPreview.url}
            snippet={externalPreview.snippet || fileContent}
          />
        ) : category === "markdown" ? (
          <WikiEditor
            key={selectedFile}
            content={fileContent}
            onSave={handleSave}
            filePath={selectedFile}
          />
        ) : (
          <FilePreview
            key={selectedFile}
            filePath={selectedFile}
            textContent={fileContent}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Wrap any matching tokens in `<mark>` so the suggestion list echoes
 * the Search view's highlighting. Falls back to a plain lower-cased
 * substring match when tokenization returned nothing (e.g. user typed
 * only punctuation).
 */
function highlightMatch(text: string, tokens: string[], fallback: string) {
  const matches: Array<{ start: number; end: number }> = []
  if (tokens.length > 0) {
    for (const token of tokens) {
      if (!token) continue
      let index = 0
      while (index < text.length) {
        const found = text.toLowerCase().indexOf(token, index)
        if (found < 0) break
        matches.push({ start: found, end: found + token.length })
        index = found + Math.max(1, token.length)
      }
    }
  } else if (fallback) {
    let index = 0
    while (index < text.length) {
      const found = text.toLowerCase().indexOf(fallback, index)
      if (found < 0) break
      matches.push({ start: found, end: found + fallback.length })
      index = found + Math.max(1, fallback.length)
    }
  }
  if (matches.length === 0) return text
  matches.sort((left, right) => left.start - right.start)
  const filtered: Array<{ start: number; end: number }> = []
  for (const range of matches) {
    const last = filtered[filtered.length - 1]
    if (last && range.start < last.end) {
      last.end = Math.max(last.end, range.end)
      continue
    }
    filtered.push(range)
  }
  const parts: Array<string | { kind: "mark"; text: string }> = []
  let cursor = 0
  for (const range of filtered) {
    if (cursor < range.start) {
      parts.push(text.slice(cursor, range.start))
    }
    parts.push({ kind: "mark", text: text.slice(range.start, range.end) })
    cursor = range.end
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }
  return parts.map((part, idx) =>
    typeof part === "string" ? (
      <span key={`plain-${idx}`}>{part}</span>
    ) : (
      <mark key={`mark-${idx}`} className="bg-primary/20 text-foreground">
        {part.text}
      </mark>
    ),
  )
}

function ExternalReferencePreview({
  source,
  title,
  path,
  snippet,
}: {
  source: string
  title: string
  path: string
  snippet: string
}) {
  return (
    <div className="flex h-full flex-col overflow-auto p-6">
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
            {source}
          </span>
          <h3 className="truncate text-sm font-medium" title={title}>{title}</h3>
        </div>
        <div className="break-all rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {path}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60 bg-background p-4">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
          {snippet || "(No preview fragment returned.)"}
        </pre>
      </div>
    </div>
  )
}
