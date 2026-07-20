import { describe, expect, it } from "vitest"
import type { ChatAnnotation, AnnotationStatus } from "./chat-agent-types"
import type { DisplayMessage } from "../stores/chat-store"

declare const ann: ChatAnnotation
declare const msg: DisplayMessage

// ChatAnnotation 必须有这些字段
const _id: string = ann.id
const _parent: string = ann.parentMessageId
const _snippet: string = ann.snippet
const _status: AnnotationStatus = ann.status
const _created: number = ann.createdAt
const _thread: DisplayMessage[] = ann.thread

// status 必须是三个值之一
const _open: AnnotationStatus = "open"
const _resolved: AnnotationStatus = "resolved"
const _flattened: AnnotationStatus = "flattened"

// range 可选，但若有必须含 start/end
const _start: number = ann.range!.start
const _end: number = ann.range!.end

// DisplayMessage.annotations 可选
const _annos: ChatAnnotation[] | undefined = msg.annotations

describe("ChatAnnotation type contract", () => {
  it("declares required fields with correct types", () => {
    expect([
      _id,
      _parent,
      _snippet,
      _status,
      _created,
      _thread,
      _open,
      _resolved,
      _flattened,
      _start,
      _end,
      _annos,
    ]).toHaveLength(12)
  })
})