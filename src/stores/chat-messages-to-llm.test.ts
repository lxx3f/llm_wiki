import { describe, it, expect } from "vitest"
import { chatMessagesToLLM, type DisplayMessage } from "./chat-store"

function msg(partial: Partial<DisplayMessage> & Pick<DisplayMessage, "role" | "content">): DisplayMessage {
  return {
    id: "1",
    timestamp: 0,
    conversationId: "c1",
    ...partial,
  }
}

describe("chatMessagesToLLM", () => {
  it("keeps the legacy string shape when a message has no images", () => {
    const message = msg({ role: "user", content: "hello" })
    const out = chatMessagesToLLM([message])
    // The implementation forwards the source message's id as the wire id.
    expect(out).toEqual([{ id: message.id, role: "user", content: "hello" }])
  })

  it("keeps string shape when images is an empty array", () => {
    const out = chatMessagesToLLM([msg({ role: "user", content: "hi", images: [] })])
    expect(out[0].content).toBe("hi")
  })

  it("emits ContentBlock[] (text first, then image blocks) when images are present", () => {
    const out = chatMessagesToLLM([
      msg({
        role: "user",
        content: "what is this?",
        images: [
          { mediaType: "image/png", dataBase64: "AAAA" },
          { mediaType: "image/jpeg", dataBase64: "BBBB" },
        ],
      }),
    ])
    expect(out[0].role).toBe("user")
    expect(out[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", mediaType: "image/png", dataBase64: "AAAA" },
      { type: "image", mediaType: "image/jpeg", dataBase64: "BBBB" },
    ])
  })

  it("still includes a (possibly empty) text block for image-only messages", () => {
    const out = chatMessagesToLLM([
      msg({ role: "user", content: "", images: [{ mediaType: "image/webp", dataBase64: "CCCC" }] }),
    ])
    const blocks = out[0].content as Array<{ type: string }>
    expect(blocks[0]).toEqual({ type: "text", text: "" })
    expect(blocks[1]).toEqual({ type: "image", mediaType: "image/webp", dataBase64: "CCCC" })
  })
})

describe("chatMessagesToLLM filters annotation thread", () => {
  it("excludes messages marked as annotation thread", () => {
    const main: DisplayMessage = {
      id: "m1", role: "user", content: "main Q", timestamp: 1,
      conversationId: "c1",
    }
    const annThreadMsg: DisplayMessage = {
      id: "a1", role: "user", content: "follow-up",
      timestamp: 2, conversationId: "c1", threadKind: "annotation",
    }
    const out = chatMessagesToLLM([main, annThreadMsg], "c1")
    expect(out.map(m => m.id)).toEqual(["m1"])
  })

  it("includes flattened messages from annotation", () => {
    const main: DisplayMessage = {
      id: "m1", role: "user", content: "main", timestamp: 1, conversationId: "c1",
    }
    const flattened: DisplayMessage = {
      id: "f1", role: "user", content: "from annotation",
      timestamp: 2, conversationId: "c1",
      flattenedFromAnnotation: "ann_1",
    }
    const out = chatMessagesToLLM([main, flattened], "c1")
    expect(out.map(m => m.id)).toEqual(["m1", "f1"])
  })
})
