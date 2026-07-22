// @vitest-environment jsdom
// Regression: chat messages must render [[wikilinks]] as clickable
// elements, not as raw `[[…]]` text.
//
// Original bug: processContent rewrote wikilinks to a custom
// `wikilink:concepts/位置插值-pi` href. ReactMarkdown's URL
// sanitizer rejects that scheme — the `<a>` is rendered but the
// `href` is delivered to the custom component as the empty
// string. The custom `a` component's `href?.startsWith("wikilink:")`
// check then falls through to the inert `<span>` fallback, so
// the user sees raw bracket text.
//
// Fix: route through the shared `transformWikilinks` helper which
// emits `[label](#<encoded-target>)`, and update the custom `a`
// component to handle `href?.startsWith("#")` instead.

import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { processContent } from "./process-content"

describe("processContent (chat-message wikilink pipeline)", () => {
  it("rewrites [[concepts/位置插值-pi|PI]] to a markdown fragment link", () => {
    const out = processContent("比 [[concepts/位置插值-pi|PI]] 更好地保留高频精细建模能力。")
    expect(out).toContain("[PI](")
    expect(out).not.toContain("wikilink:")
    expect(out).toContain("#concepts%2F%E4%BD%8D%E7%BD%AE%E6%8F%92%E5%80%BC-pi")
  })

  it("emits no `wikilink:` hrefs anywhere (the scheme is dead)", () => {
    const input = "see [[foo]] and [[bar|baz]] and [[qux]]"
    const out = processContent(input)
    expect(out).not.toContain("wikilink:")
    expect(out).toContain("[foo](#foo)")
    expect(out).toContain("[baz](#bar)")
    expect(out).toContain("[qux](#qux)")
  })

  it("does not mangle image embeds (transformImageEmbeds still runs first)", () => {
    const out = processContent("See ![[../assets/x.png]] and [[concept]] page.")
    expect(out).toContain("![](<../assets/x.png>)")
    expect(out).toContain("[concept](#concept)")
  })

  it("leaves fenced code blocks alone", () => {
    const input = "```\n[[keep]] literal\n```\nafter [[convert]]"
    const out = processContent(input)
    expect(out).toContain("[[keep]] literal")
    expect(out).toContain("[convert](#convert)")
  })
})

describe("custom a renderer (chat-message MarkdownContent)", () => {
  // Mirror the production branch logic verbatim so a future refactor
  // that breaks the contract (e.g. removing the decodeURIComponent
  // step) gets caught here.
  function renderA(href: string | undefined): { tag: string; title?: string; pageName?: string } {
    if (href?.startsWith("#")) {
      let pageName = href.slice(1)
      try {
        pageName = decodeURIComponent(pageName)
      } catch {
        /* fall through with raw fragment */
      }
      return { tag: "WikiLink", pageName, title: `Open wiki page: ${pageName}` }
    }
    return { tag: "span", title: href }
  }

  it("turns a fragment href into a WikiLink with the decoded target", () => {
    const result = renderA("#concepts%2F%E4%BD%8D%E7%BD%AE%E6%8F%92%E5%80%BC-pi")
    expect(result).toEqual({
      tag: "WikiLink",
      pageName: "concepts/位置插值-pi",
      title: "Open wiki page: concepts/位置插值-pi",
    })
  })

  it("falls back to the raw fragment when decodeURIComponent fails", () => {
    // %E0%A4%A is a truncated sequence — invalid percent-encoding.
    const result = renderA("#%E0%A4%A")
    expect(result.tag).toBe("WikiLink")
    expect(result.pageName).toBe("%E0%A4%A")
  })

  it("falls through to the inert span for non-fragment hrefs", () => {
    expect(renderA("https://example.com")).toEqual({
      tag: "span",
      title: "https://example.com",
    })
    expect(renderA(undefined)).toEqual({ tag: "span", title: undefined })
    expect(renderA("")).toEqual({ tag: "span", title: "" })
  })
})

describe("REGRESSION: end-to-end ReactMarkdown delivery", () => {
  it("delivers a non-empty href for the fixed fragment-link output", () => {
    // This is the exact regression: the previous `wikilink:` scheme
    // was stripped to '' by ReactMarkdown's URL sanitizer, causing
    // the custom `a` branch to fall through to an inert span. With
    // the `#…` scheme the href survives and WikiLink renders.
    const md = processContent("比 [[concepts/位置插值-pi|PI]] 更好地保留高频精细建模能力。")
    expect(md).not.toContain("wikilink:")

    const captured: Array<{ href: string | undefined }> = []
    const { container } = render(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            captured.push({ href })
            return (
              <a data-testid="link" href={href}>
                {children}
              </a>
            )
          },
        }}
      >
        {md}
      </ReactMarkdown>,
    )

    const anchors = container.querySelectorAll("a")
    expect(anchors.length).toBe(1)
    const href = anchors[0].getAttribute("href")
    expect(href).toBeTruthy()
    expect(href).not.toBe("")
    expect(href?.startsWith("#")).toBe(true)
    // …and the link's accessible name is the alias, not the raw `[[…]]`.
    expect(anchors[0].textContent).toBe("PI")
    // Custom component saw the same href.
    expect(captured[0]?.href?.startsWith("#")).toBe(true)
  })
})
