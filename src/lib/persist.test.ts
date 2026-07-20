/**
 * Tier 4 — real-FS round-trip tests for ChatAnnotation + annotation markers.
 *
 * Verifies that the three new DisplayMessage fields introduced in Phase 1
 * of the chat annotation work (`annotations`, `threadKind`,
 * `flattenedFromAnnotation`) survive the JSON write/read cycle unchanged,
 * and that legacy conversation files written before those fields existed
 * still load without throwing.
 *
 * Persistence is wholesale JSON.stringify on the current implementation
 * (see persist.ts), so these tests primarily act as a regression guard
 * against future introduction of a strict field whitelist that would
 * silently drop the new fields.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { realFs, createTempProject, writeFileRaw } from "@/test-helpers/fs-temp"
import type { Conversation, DisplayMessage } from "@/stores/chat-store"
import type { ChatAnnotation } from "@/lib/chat-agent-types"

vi.mock("@/commands/fs", () => realFs)

import { saveChatHistory, loadChatHistory } from "./persist"

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  tmp = await createTempProject("persist-annotation")
})

afterEach(async () => {
  await tmp.cleanup()
})

describe("persist annotation fields", () => {
  it("round-trips annotations array + threadKind + flattenedFromAnnotation", async () => {
    const annotation: ChatAnnotation = {
      id: "ann_1",
      parentMessageId: "m1",
      snippet: "highlighted snippet",
      range: { start: 0, end: 9 },
      status: "open",
      createdAt: 2,
      thread: [{
        id: "am1",
        role: "user",
        content: "follow-up question",
        timestamp: 3,
        conversationId: "c1",
        threadKind: "annotation",
      }],
    }

    const conv: Conversation = {
      id: "c1",
      title: "annotated chat",
      createdAt: 1,
      updatedAt: 2,
    }

    const messages: DisplayMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "Body of the assistant reply.",
        timestamp: 1,
        conversationId: "c1",
        annotations: [annotation],
      },
      {
        id: "m2",
        role: "user",
        content: "Why?",
        timestamp: 2,
        conversationId: "c1",
        threadKind: "annotation",
      },
      {
        id: "m3",
        role: "assistant",
        content: "Because…",
        timestamp: 3,
        conversationId: "c1",
        flattenedFromAnnotation: "ann_1",
      },
    ]

    await saveChatHistory(tmp.path, [conv], messages)
    const loaded = await loadChatHistory(tmp.path)

    const loadedById = new Map(loaded.messages.map((m) => [m.id, m]))

    const parent = loadedById.get("m1")!
    expect(parent.annotations).toEqual([annotation])

    const threadMsg = loadedById.get("m2")!
    expect(threadMsg.threadKind).toBe("annotation")

    const flattenedMsg = loadedById.get("m3")!
    expect(flattenedMsg.flattenedFromAnnotation).toBe("ann_1")
  })

  it("legacy conversation without annotations loads without error", async () => {
    // Simulate a conversation file written before Phase 1 added the
    // annotation fields. The message carries none of the new optional
    // fields, so the loader must treat them as undefined rather than
    // throw a missing-key error or coerce to an empty array.
    const legacyMessages = [
      {
        id: "m1",
        role: "user",
        content: "old message",
        timestamp: 100,
        conversationId: "c1",
      },
      {
        id: "m2",
        role: "assistant",
        content: "old reply",
        timestamp: 200,
        conversationId: "c1",
      },
    ]

    await writeFileRaw(
      `${tmp.path}/.llm-wiki/chats/c1.json`,
      JSON.stringify(legacyMessages),
    )

    const loaded = await loadChatHistory(tmp.path)

    expect(loaded.messages).toHaveLength(2)
    expect(loaded.messages[0].annotations).toBeUndefined()
    expect(loaded.messages[0].threadKind).toBeUndefined()
    expect(loaded.messages[0].flattenedFromAnnotation).toBeUndefined()
    expect(loaded.messages[1].annotations).toBeUndefined()
  })
})
