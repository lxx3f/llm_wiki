/**
 * Stub for Task 2.2: real implementation lands in Task 2.3
 * (annotation CRUD + state machine). This file exists so that
 * `ChatAnnotationTrigger` has a concrete import target today and
 * tests can mock `./useAnnotationActions` via `vi.mock`.
 */
import type { ChatAnnotation } from "@/lib/chat-agent-types"

export interface CreateAnnotationArgs {
  parentMessageId: string
  snippet: string
  range?: { start: number; end: number }
}

export interface AnnotationActions {
  createAnnotation: (args: CreateAnnotationArgs) => ChatAnnotation | null
}

export function useAnnotationActions(): AnnotationActions {
  return {
    createAnnotation: () => null,
  }
}
