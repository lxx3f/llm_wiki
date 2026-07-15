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
  refresh,
  selectedFile,
  read,
  setFileContent,
}: {
  pendingWrite: ChatPendingWikiWrite
  projectId: string
  projectPath: string
  sessionId: string | null
  confirm: (projectId: string, sessionId: string | null, pendingWriteId: string) => Promise<AgentConfirmedWikiWrite>
  refresh: (projectPath: string, options: { bumpDataVersion: boolean }) => Promise<void>
  selectedFile: string | null
  read: (path: string) => Promise<string>
  setFileContent: (content: string) => void
}) {
  const confirmed = await confirm(projectId, sessionId, pendingWrite.id)
  const path = confirmedProjectPath(projectPath, confirmed.reference.path)
  await refresh(projectPath, { bumpDataVersion: true })
  if (isConfirmedWriteForSelectedFile(selectedFile, path)) {
    setFileContent(await read(path))
  }

  return {
    path,
    content: pendingWrite.content,
    existedBefore: confirmed.existedBefore,
  }
}

export function cancelPendingWikiWrite<T extends { id: string; pendingWikiWrite?: ChatPendingWikiWrite }>(messages: T[], messageId: string): T[] {
  return messages.map((message) => message.id === messageId ? { ...message, pendingWikiWrite: undefined } : message)
}
