export interface SelectionWithin {
  snippet: string
  range: { start: number; end: number }
}

/**
 * 取当前 window selection；若不在 root 内、或为空/折叠、或跨越 root 边界则返回 null。
 *
 * range 是基于 root.textContent 的 UTF-16 code unit 偏移（与 String.prototype.slice 一致）。
 */
export function getSelectionWithin(root: HTMLElement): SelectionWithin | null {
  const sel = typeof window !== "undefined" ? window.getSelection() : null
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null

  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null
  }
  if (range.collapsed) return null

  const snippet = sel.toString().trim()
  if (!snippet) return null

  const charRange = getCharacterRange(root, range)
  return { snippet, range: charRange }
}

/**
 * 把 DOM Range 转为 root.textContent 内的字符偏移。
 * 使用 Range.toString() 累计偏移，对 surrogate pair 安全（toString 返回 UTF-16 长度）。
 */
export function getCharacterRange(
  root: HTMLElement,
  range: Range,
): { start: number; end: number } {
  const preRange = document.createRange()
  preRange.selectNodeContents(root)
  preRange.setEnd(range.startContainer, range.startOffset)
  const start = preRange.toString().length

  const fullRange = document.createRange()
  fullRange.selectNodeContents(root)
  fullRange.setEnd(range.endContainer, range.endOffset)
  const end = fullRange.toString().length

  return { start, end }
}
