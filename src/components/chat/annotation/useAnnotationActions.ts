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
export interface AnnotationActions {
  createAnnotation: (args: CreateAnnotationArgs) => string | null
  appendAnnotationMessage: (
    annotationId: string,
    role: "user" | "assistant",
    content: string,
  ) => void
  resolveAnnotation: (annotationId: string) => void
  flattenAnnotation: (annotationId: string) => string[]
}

export function useAnnotationActions(): AnnotationActions {
  const storeCreateAnnotation = useChatStore((s) => s.createAnnotation)
  const appendAnnotationMessage = useChatStore((s) => s.appendAnnotationMessage)
  const resolveAnnotation = useChatStore((s) => s.resolveAnnotation)
  const flattenAnnotation = useChatStore((s) => s.flattenAnnotation)

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

  return {
    createAnnotation,
    appendAnnotationMessage,
    resolveAnnotation,
    flattenAnnotation,
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