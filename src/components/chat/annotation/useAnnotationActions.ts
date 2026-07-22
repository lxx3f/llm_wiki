/**
 * Hook surface for annotation CRUD actions living on the Zustand chat-store.
 *
 * The store (Task 1.1-1.2) exposes `createAnnotation`, `appendAnnotationMessage`,
 * `resolveAnnotation`, and `flattenAnnotation`. This hook adapts them to the
 * `{ parentMessageId, snippet, range? }` argument shape that the trigger
 * components (`ChatAnnotationTrigger`, `PerParagraphTrigger`) consume.
 *
 * Keeping the exported interface names (`CreateAnnotationArgs`, `AnnotationActions`,
 * `useAnnotationActions`) stable means callers and `vi.mock` mocks from
 * Tasks 2.2 / 2.2b keep working unchanged.
 *
 * `useAutoResolveAnnotations` is a side-effect-only companion hook that
 * mounts a 30s timer in `ChatSessionContent` and auto-resolves any open
 * annotation older than `AUTO_RESOLVE_MS` (5 minutes — spec §2.5).
 */
import { useCallback, useEffect } from "react"
import { useChatStore } from "@/stores/chat-store"

const AUTO_RESOLVE_MS = 5 * 60 * 1000
const AUTO_RESOLVE_INTERVAL_MS = 30_000

export interface CreateAnnotationArgs {
  parentMessageId: string
  snippet: string
  range?: { start: number; end: number }
}

/**
 * Surface exposed by `useAnnotationActions`. The adapter in `useAnnotationActions`
 * binds each method to the corresponding Zustand `chat-store` action.
 *
 * Note: `createAnnotation` deliberately returns the **created annotation id**
 * (`string | null`), NOT the full `ChatAnnotation` record. The Task 2.2 stub
 * originally returned `ChatAnnotation | null`, but the underlying store action
 * (`src/stores/chat-store.ts:createAnnotation`) returns the id — so the hook
 * is faithful to the store. Callers that need the full annotation should look
 * it up via the store (`useChatStore.getState().messages[*].annotations`) using
 * the returned id; returning the id (rather than the object) also avoids a
 * second source of truth that could drift from the store's record.
 */
export interface AskAnnotationQuestionArgs {
  parentMessageId: string
  snippet: string
  range?: { start: number; end: number }
  question: string
}

export interface AnnotationActions {
  createAnnotation: (args: CreateAnnotationArgs) => string | null
  appendAnnotationMessage: (
    annotationId: string,
    role: "user" | "assistant",
    content: string,
  ) => void
  resolveAnnotation: (annotationId: string) => void
  flattenAnnotation: (annotationId: string) => string[]
  /**
   * Task 6.1: persist a generated wiki markdown payload against the
   * annotation's `wikiPath` backlink. The actual file write is
   * deferred (see `ChatState.saveAnnotationToWiki` docstring); this
   * hook entry-point exists so dialogs and tests can route through
   * the same adapter rather than touching the store directly.
   */
  saveAnnotationToWiki: (annotationId: string, targetPath: string, content: string) => void
  /**
   * Combined annotation-question dispatch (Phase 7.x): creates the
   * annotation row, appends the user's question, and invokes the
   * backend Agent with `annotation` context so the stream listener
   * routes events to the annotation thread. Returns the new
   * annotation id, or `null` if creation was rejected.
   */
  askAnnotationQuestion: (args: AskAnnotationQuestionArgs) => Promise<string | null>
}

export function useAnnotationActions(): AnnotationActions {
  const storeCreateAnnotation = useChatStore((s) => s.createAnnotation)
  const appendAnnotationMessage = useChatStore((s) => s.appendAnnotationMessage)
  const resolveAnnotation = useChatStore((s) => s.resolveAnnotation)
  const flattenAnnotation = useChatStore((s) => s.flattenAnnotation)
  const saveAnnotationToWiki = useChatStore((s) => s.saveAnnotationToWiki)
  const storeAskAnnotationQuestion = useChatStore((s) => s.askAnnotationQuestion)

  const createAnnotation = useCallback(
    (args: CreateAnnotationArgs): string | null => {
      try {
        return storeCreateAnnotation(args.parentMessageId, args.snippet, args.range)
      } catch {
        // Parent message gone (e.g. conversation switched) — swallow so
        // the trigger UI can no-op rather than crash the right-click path.
        return null
      }
    },
    [storeCreateAnnotation],
  )

  const askAnnotationQuestion = useCallback(
    async (args: AskAnnotationQuestionArgs): Promise<string | null> => {
      try {
        return await storeAskAnnotationQuestion(args)
      } catch {
        // Same swallow-and-return-null pattern as `createAnnotation`:
        // the parent message may have been pruned while the user was
        // typing in the popover. The annotation stays empty in the
        // store; the user can re-trigger from the (still rendered)
        // parent message.
        return null
      }
    },
    [storeAskAnnotationQuestion],
  )

  return {
    createAnnotation,
    appendAnnotationMessage,
    resolveAnnotation,
    flattenAnnotation,
    saveAnnotationToWiki,
    askAnnotationQuestion,
  }
}

/**
 * Mount inside `ChatSessionContent` (or anywhere with stable lifetime).
 * Sets up a 30s interval that auto-resolves any `open` annotation whose
 * `createdAt` is older than `AUTO_RESOLVE_MS`. Cleared on unmount.
 *
 * Uses `useChatStore.getState()` inside the timer callback so the interval
 * doesn't re-fire whenever `messages` changes — only the mount itself
 * sets up the timer (empty dep array).
 */
export function useAutoResolveAnnotations(): void {
  useEffect(() => {
    const tick = () => {
      const { messages, resolveAnnotation } = useChatStore.getState()
      const now = Date.now()
      const toResolve: string[] = []
      for (const m of messages) {
        for (const a of m.annotations ?? []) {
          if (a.status === "open" && now - a.createdAt > AUTO_RESOLVE_MS) {
            toResolve.push(a.id)
          }
        }
      }
      toResolve.forEach((id) => resolveAnnotation(id))
    }
    const handle = setInterval(tick, AUTO_RESOLVE_INTERVAL_MS)
    return () => clearInterval(handle)
  }, [])
}