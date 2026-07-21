/**
 * Split markdown content into "visual paragraphs" for per-paragraph
 * annotation triggers. Respects fenced code blocks (``` and ~~~)
 * so blank lines inside a fence do NOT count as paragraph breaks.
 *
 * Also normalizes \r\n → \n so Windows line endings don't break the
 * splitting logic.
 */
export function splitMarkdownParagraphs(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n")

  const paragraphs: string[] = []
  const lines = normalized.split("\n")
  let current: string[] = []
  let inFence = false
  let fenceMarker = ""

  for (const line of lines) {
    const trimmed = line.trimStart()
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/)

    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fenceMarker = fenceMatch[1][0]
      } else if (
        fenceMarker === fenceMatch[1][0] &&
        trimmed.match(new RegExp(`^${fenceMarker}{3,}`))
      ) {
        inFence = false
        fenceMarker = ""
      }
    }

    if (trimmed === "" && !inFence) {
      if (current.length > 0) {
        paragraphs.push(current.join("\n"))
        current = []
      }
    } else {
      current.push(line)
    }
  }

  if (current.length > 0) {
    paragraphs.push(current.join("\n"))
  }

  return paragraphs
}
