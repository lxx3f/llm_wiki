// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, fireEvent } from "@testing-library/react"
import { ChatAnnotationQuestionInput } from "./ChatAnnotationQuestionInput"

afterEach(() => {
  cleanup()
})

describe("ChatAnnotationQuestionInput", () => {
  const anchor = { x: 120, y: 200 }

  it("renders nothing when anchor is null", () => {
    const { container } = render(
      <ChatAnnotationQuestionInput
        anchor={null}
        snippet="some snippet"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders snippet label and a textarea when anchor is set", () => {
    const { getByRole, getByText } = render(
      <ChatAnnotationQuestionInput
        anchor={anchor}
        snippet="hello world"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(getByText(/hello world/)).toBeTruthy()
    expect(getByRole("textbox")).toBeTruthy()
  })

  it("Enter (without shift) calls onSubmit with trimmed value", () => {
    const onSubmit = vi.fn()
    const { getByRole } = render(
      <ChatAnnotationQuestionInput
        anchor={anchor}
        snippet="snippet"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )
    const ta = getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "  what does this mean?  " } })
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: false })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith("what does this mean?")
  })

  it("Shift+Enter inserts a newline and does NOT call onSubmit", () => {
    const onSubmit = vi.fn()
    const { getByRole } = render(
      <ChatAnnotationQuestionInput
        anchor={anchor}
        snippet="snippet"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )
    const ta = getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "line1" } })
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("Enter with empty value does not call onSubmit", () => {
    const onSubmit = vi.fn()
    const { getByRole } = render(
      <ChatAnnotationQuestionInput
        anchor={anchor}
        snippet="snippet"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )
    const ta = getByRole("textbox") as HTMLTextAreaElement
    fireEvent.keyDown(ta, { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("Escape calls onCancel", () => {
    const onCancel = vi.fn()
    const { getByRole } = render(
      <ChatAnnotationQuestionInput
        anchor={anchor}
        snippet="snippet"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.keyDown(getByRole("textbox"), { key: "Escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("the 'send' button is disabled when the textarea is empty", () => {
    const { getByRole } = render(
      <ChatAnnotationQuestionInput
        anchor={anchor}
        snippet="snippet"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    const sendBtn = getByRole("button", { name: "发送" })
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it("the 'send' button is disabled when the textarea only has whitespace", () => {
    const { getByRole } = render(
      <ChatAnnotationQuestionInput
        anchor={anchor}
        snippet="snippet"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    const ta = getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "   " } })
    const sendBtn = getByRole("button", { name: "发送" })
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it("clicking the 'send' button calls onSubmit with trimmed value", () => {
    const onSubmit = vi.fn()
    const { getByRole } = render(
      <ChatAnnotationQuestionInput
        anchor={anchor}
        snippet="snippet"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )
    const ta = getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "  a question  " } })
    fireEvent.click(getByRole("button", { name: "发送" }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith("a question")
  })

  it("clicking the 'cancel' button calls onCancel", () => {
    const onCancel = vi.fn()
    const { getByRole } = render(
      <ChatAnnotationQuestionInput
        anchor={anchor}
        snippet="snippet"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(getByRole("button", { name: "取消" }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("clicking outside the popover calls onCancel", () => {
    const onCancel = vi.fn()
    render(
      <div>
        <div data-testid="outside">elsewhere</div>
        <ChatAnnotationQuestionInput
          anchor={anchor}
          snippet="snippet"
          onSubmit={vi.fn()}
          onCancel={onCancel}
        />
      </div>,
    )
    fireEvent.mouseDown(document.querySelector("[data-testid='outside']") as Element)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("clicking inside the popover does NOT call onCancel", () => {
    const onCancel = vi.fn()
    const { getByRole } = render(
      <ChatAnnotationQuestionInput
        anchor={anchor}
        snippet="snippet"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.mouseDown(getByRole("textbox"))
    expect(onCancel).not.toHaveBeenCalled()
  })
})
