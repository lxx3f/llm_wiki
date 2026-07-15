import type { ChatPendingWikiWrite } from "@/lib/chat-agent-types"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"

export type AgentConfirmedWikiWrite = {
  reference: { path: string }
  existedBefore: boolean
  previousContent?: string
}

export type PendingMessage<T extends { id: string; pendingWikiWrite?: ChatPendingWikiWrite }> = T

export function confirmedProjectPath(projectPath: string, path: string): string {
  const normalizedProject = normalizePath(projectPath).replace(/\/+$/, "")
  const normalizedPath = normalizePath(path)
  return isAbsolutePath(normalizedPath)
    ? normalizedPath
    : `${normalizedProject}/${normalizedPath.replace(/^\/+/, "")}`
}

export function isConfirmedWriteForSelectedFile(selectedFile: string | null, confirmedPath: string): boolean {
  return selectedFile !== null && normalizePath(selectedFile) === normalizePath(confirmedPath)
}

export async function confirmPendingWikiWrite({
  pendingWrite,
  projectId,
  projectPath,
  sessionId,
  confirm,
}: {
  pendingWrite: ChatPendingWikiWrite
  projectId: string
  projectPath: string
  sessionId: string | null
  confirm: (projectId: string, sessionId: string | null, pendingWriteId: string) => Promise<AgentConfirmedWikiWrite>
}) {
  const confirmed = await confirm(projectId, sessionId, pendingWrite.id)
  return {
    path: confirmedProjectPath(projectPath, confirmed.reference.path),
    content: pendingWrite.content,
    existedBefore: confirmed.existedBefore,
  }
}

export async function refreshConfirmedWikiWrite({
  projectPath,
  confirmedPath,
  refresh,
  getSelectedFile,
  read,
  setFileContent,
  onError = (error) => console.error("Failed to refresh confirmed wiki write:", error),
}: {
  projectPath: string
  confirmedPath: string
  refresh: (projectPath: string, options: { bumpDataVersion: boolean }) => Promise<void>
  getSelectedFile: () => string | null
  read: (path: string) => Promise<string>
  setFileContent: (content: string) => void
  onError?: (error: unknown) => void
}): Promise<void> {
  try {
    await refresh(projectPath, { bumpDataVersion: true })
    if (!isConfirmedWriteForSelectedFile(getSelectedFile(), confirmedPath)) return

    const content = await read(confirmedPath)
    if (isConfirmedWriteForSelectedFile(getSelectedFile(), confirmedPath)) {
      setFileContent(content)
    }
  } catch (error) {
    onError(error)
  }
}

export function cancelPendingWikiWrite<T extends { id: string; pendingWikiWrite?: ChatPendingWikiWrite }>(messages: T[], messageId: string): T[] {
  return messages.map((message) => message.id === messageId ? { ...message, pendingWikiWrite: undefined } : message)
}
