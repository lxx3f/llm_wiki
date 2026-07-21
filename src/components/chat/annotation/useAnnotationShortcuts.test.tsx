// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { useAnnotationShortcuts } from "./useAnnotationShortcuts"

/**
 * Lightweight harness: the hook only needs a stable mount lifetime
 * to register its `keydown` listener on `window`. A no-op component
 * is enough — the callbacks are the unit under test, not the JSX.
 */
function Harness({
  onCreate,
  onToggleDrawer,
}: {
  onCreate: () => void
  onToggleDrawer: () => void
}) {
  useAnnotationShortcuts({ onCreate, onToggleDrawer })
  return null
}

afterEach(() => {
  cleanup()
})

describe("useAnnotationShortcuts", () => {
  it("calls onCreate on Cmd+K (Meta)", () => {
    const onCreate = vi.fn()
    const onToggleDrawer = vi.fn()
    render(<Harness onCreate={onCreate} onToggleDrawer={onToggleDrawer} />)

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    )
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onToggleDrawer).not.toHaveBeenCalled()
  })

  it("calls onCreate on Ctrl+K", () => {
    const onCreate = vi.fn()
    const onToggleDrawer = vi.fn()
    render(<Harness onCreate={onCreate} onToggleDrawer={onToggleDrawer} />)

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
    )
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onToggleDrawer).not.toHaveBeenCalled()
  })

  it("calls onToggleDrawer on Cmd+Shift+A (Meta)", () => {
    const onCreate = vi.fn()
    const onToggleDrawer = vi.fn()
    render(<Harness onCreate={onCreate} onToggleDrawer={onToggleDrawer} />)

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "A",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    )
    expect(onToggleDrawer).toHaveBeenCalledTimes(1)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it("calls onToggleDrawer on Ctrl+Shift+A", () => {
    const onCreate = vi.fn()
    const onToggleDrawer = vi.fn()
    render(<Harness onCreate={onCreate} onToggleDrawer={onToggleDrawer} />)

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    )
    expect(onToggleDrawer).toHaveBeenCalledTimes(1)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it("does not call either callback on Escape (intentional no-op)", () => {
    const onCreate = vi.fn()
    const onToggleDrawer = vi.fn()
    render(<Harness onCreate={onCreate} onToggleDrawer={onToggleDrawer} />)

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    )
    expect(onCreate).not.toHaveBeenCalled()
    expect(onToggleDrawer).not.toHaveBeenCalled()
  })

  it("does not call either callback for plain key presses", () => {
    const onCreate = vi.fn()
    const onToggleDrawer = vi.fn()
    render(<Harness onCreate={onCreate} onToggleDrawer={onToggleDrawer} />)

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }))
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "K", shiftKey: true, bubbles: true }),
    )
    expect(onCreate).not.toHaveBeenCalled()
    expect(onToggleDrawer).not.toHaveBeenCalled()
  })

  it("does not call onCreate for plain Shift+A without modifier", () => {
    const onCreate = vi.fn()
    const onToggleDrawer = vi.fn()
    render(<Harness onCreate={onCreate} onToggleDrawer={onToggleDrawer} />)

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", shiftKey: true, bubbles: true }),
    )
    expect(onCreate).not.toHaveBeenCalled()
    expect(onToggleDrawer).not.toHaveBeenCalled()
  })

  it("removes the listener on unmount", () => {
    const onCreate = vi.fn()
    const onToggleDrawer = vi.fn()
    const { unmount } = render(
      <Harness onCreate={onCreate} onToggleDrawer={onToggleDrawer} />,
    )
    unmount()
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    )
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "A",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    )
    expect(onCreate).not.toHaveBeenCalled()
    expect(onToggleDrawer).not.toHaveBeenCalled()
  })

  it("picks up the latest callbacks on re-render", () => {
    const onCreate1 = vi.fn()
    const onCreate2 = vi.fn()
    const onToggleDrawer = vi.fn()
    const { rerender } = render(
      <Harness onCreate={onCreate1} onToggleDrawer={onToggleDrawer} />,
    )
    rerender(<Harness onCreate={onCreate2} onToggleDrawer={onToggleDrawer} />)
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    )
    expect(onCreate1).not.toHaveBeenCalled()
    expect(onCreate2).toHaveBeenCalledTimes(1)
  })
})