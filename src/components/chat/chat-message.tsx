import { memo, useCallback, useEffect, useState, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { convertFileSrc } from "@tauri-apps/api/core"
import "katex/dist/katex.min.css"
import {
  Bot, User, FileText, BookmarkPlus, ChevronDown, ChevronRight, RefreshCw, Copy, Check,
  Users, Lightbulb, BookOpen, HelpCircle, GitMerge, BarChart3, Layout, Globe,
  TrendingUp, Target, Sparkles, Image as ImageIcon, FileSearch, Terminal,
} from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { lastQueryPages } from "@/components/chat/chat-panel"
import type { DisplayMessage, MessageReference } from "@/stores/chat-store"
import type { FileNode } from "@/types/wiki"

import { normalizePath, getFileName, isAbsolutePath } from "@/lib/path-utils"
import { makeQueryFileName } from "@/lib/wiki-filename"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { messageImageToDataUrl } from "@/lib/chat-image-utils"
import { findRawSourceForImage, imageUrlToAbsolute } from "@/lib/raw-source-resolver"
import { inferWikiTypeFromPath } from "@/lib/wiki-page-types"
import { cleanAssistantContentForWikiSave, titleFromCleanAssistantContent } from "@/lib/chat-save-to-wiki"
import type { ChatAgentEvent, ChatAgentStep, ChatAnnotation, ChatShellCommandApproval, ChatShellApprovalRequest, ChatUserInputField, ChatUserInputRequest } from "@/lib/chat-agent-types"
import { filterRawSourceTree } from "@/lib/source-filter"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { getFileCategory, getFileExtension, isTextReadable } from "@/lib/file-types"
import { AgentFileActivity } from "@/components/chat/agent-file-activity"
import { ReferenceKnowledgeGraph } from "@/components/chat/reference-knowledge-graph"
import { PerParagraphTrigger } from "@/components/chat/annotation/PerParagraphTrigger"
import { ChatAnnotationTrigger } from "@/components/chat/annotation/ChatAnnotationTrigger"
import { splitMarkdownParagraphs } from "./annotation/markdown-paragraphs"
import { ChatAnnotationInline } from "@/components/chat/annotation/ChatAnnotationInline"
import type { SaveAnnotationResult } from "@/components/chat/annotation/SaveAnnotationToWikiDialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { separateThinking, MarkdownContent, ThinkingBlock } from "./MarkdownContent"
import { AgentActivity as SharedAgentActivity } from "./agent-activity"

// Module-level cache of source file names
let cachedSourceFiles: string[] = []

export function useSourceFiles() {
  const project = useWikiStore((s) => s.project)

  useEffect(() => {
    if (!project) return
    const pp = normalizePath(project.path)
    listDirectory(`${pp}/raw/sources`, true)
      .then(filterRawSourceTree)
      .then((tree) => {
        cachedSourceFiles = flattenNames(tree)
      })
      .catch(() => {
        cachedSourceFiles = []
      })
  }, [project])

  return cachedSourceFiles
}

function flattenNames(nodes: FileNode[]): string[] {
  const names: string[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      names.push(...flattenNames(node.children))
    } else if (!node.is_dir) {
      names.push(node.name)
    }
  }
  return names
}

interface ChatMessageProps {
  message: DisplayMessage
  isLastAssistant?: boolean
  onRegenerate?: () => void
  onOpenReferencePreview?: (preview: ChatReferencePreview, relatedPreviews?: ChatReferencePreview[]) => void
  onResolveShellCommand?: (command: string, decision: ChatShellCommandApproval["decision"], instructions?: string) => void
  onSubmitUserInput?: (request: ChatUserInputRequest, answers: Record<string, unknown>) => boolean
  onOpenAnnotationDrawer?: () => void
  /**
   * Threaded down to `ChatAnnotationInline` so the SaveAnnotationToWikiDialog
   * can dispatch an Agent turn via the parent's `handleSend`. Supplied by
   * `ChatSessionContent`; absent in tests / read-only renderers so the
   * "save to wiki" button hides itself when there's no dispatcher.
   */
  onSaveAnnotation?: (
    annotation: ChatAnnotation,
    content: string,
    targetPath: string,
  ) => SaveAnnotationResult | Promise<SaveAnnotationResult>
}

export interface ChatReferencePreview {
  title: string
  path: string
  content: string
  source?: string
  external?: boolean
  snippet?: string
}

function ChatMessageImpl({
  message,
  isLastAssistant,
  onRegenerate,
  onOpenReferencePreview,
  onResolveShellCommand,
  onSubmitUserInput,
  onOpenAnnotationDrawer,
  onSaveAnnotation,
}: ChatMessageProps) {
  const isUser = message.role === "user"
  const isSystem = message.role === "system"
  const isAssistant = message.role === "assistant"
  const [hovered, setHovered] = useState(false)
  const { t } = useTranslation()

  return (
    <div
      className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isSystem
            ? "bg-accent text-accent-foreground"
            : isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className="max-w-[80%] min-w-0 flex flex-col gap-1.5">
        {isUser && message.contextFiles && message.contextFiles.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1">
            {message.contextFiles.map((path) => (
              <span
                key={path}
                className="inline-flex h-7 max-w-[18rem] items-center gap-1.5 rounded-md border border-blue-500/25 bg-blue-500/10 px-2 text-xs font-medium text-blue-700 dark:text-blue-300"
                title={path}
              >
                <FileText className="h-3 w-3 shrink-0" />
                <span className="truncate">@{getFileName(path)}</span>
              </span>
            ))}
          </div>
        )}
        {isUser && message.images && message.images.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 ${isUser ? "justify-end" : ""}`}>
            {message.images.map((img, i) => (
              <img
                key={i}
                src={messageImageToDataUrl(img)}
                alt=""
                className="max-h-40 max-w-[180px] rounded-lg border border-border/40 object-contain"
                loading="lazy"
              />
            ))}
          </div>
        )}
        {isAssistant && (
          (message.agentSteps?.some((step) => step.type !== "final") ?? false)
          || (message.agentFileChanges?.length ?? 0) > 0
        ) && (
          <AgentTurnActivity
            steps={message.agentSteps ?? []}
            changes={message.agentFileChanges ?? []}
            shellCommandApproval={message.shellCommandApproval}
            shellApprovalRequest={message.shellApprovalRequest}
            canResolveShellCommand={Boolean(isLastAssistant && onResolveShellCommand)}
            onResolveShellCommand={onResolveShellCommand}
          />
        )}
        {isUser && message.content && (
          <div className="rounded-lg px-3 py-2 text-sm bg-primary text-primary-foreground">
            <p dir="auto" className="whitespace-pre-wrap break-words">{message.content}</p>
          </div>
        )}
        {!isUser && (
          <ChatAnnotationTrigger message={message}>
            <div className="rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
              <AssistantParagraphs content={message.content} parentMessageId={message.id} />
            </div>
          </ChatAnnotationTrigger>
        )}
        {isAssistant &&
          message.annotations?.map((annotation) => (
            <ChatAnnotationInline
              key={annotation.id}
              annotation={annotation}
              onSaveAnnotation={onSaveAnnotation}
            />
          ))}
        {isAssistant && onOpenAnnotationDrawer && (message.annotations?.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={onOpenAnnotationDrawer}
            className="self-start inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
            title={t("annotation.action.openDrawer")}
          >
            {t("annotation.drawer.toggleLabel", {
              count: message.annotations?.length ?? 0,
            })}
          </button>
        )}
        {isAssistant && (
          <CitedReferencesPanel
            content={message.content}
            savedReferences={message.references}
            onOpenReferencePreview={onOpenReferencePreview}
          />
        )}
        {isAssistant && message.userInputRequest && (
          <UserInputRequestPanel
            request={message.userInputRequest}
            onSubmit={onSubmitUserInput}
          />
        )}
        {isAssistant && hovered && (
          <div className="flex items-center gap-1">
            <CopyButton content={message.content} />
            <SaveToWikiButton content={message.content} visible={true} />
            {isLastAssistant && onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                title="Regenerate this response"
              >
                <RefreshCw className="h-3 w-3" /> Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function AgentTurnActivity({
  steps,
  changes,
  shellCommandApproval,
  shellApprovalRequest,
  canResolveShellCommand,
  onResolveShellCommand,
}: {
  steps: ChatAgentStep[]
  changes: NonNullable<DisplayMessage["agentFileChanges"]>
  shellCommandApproval?: ChatShellCommandApproval
  shellApprovalRequest?: ChatShellApprovalRequest
  canResolveShellCommand?: boolean
  onResolveShellCommand?: (command: string, decision: ChatShellCommandApproval["decision"], instructions?: string) => void
}) {
  const { t } = useTranslation()
  return (
    <section className="rounded-md border border-border/50 bg-background/50" aria-label={t("chat.agentChanges.taskTitle")}>
      <div className="flex items-center justify-between border-b border-border/50 px-2.5 py-1.5">
        <span className="text-xs font-medium">{t("chat.agentChanges.taskTitle")}</span>
        {changes.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {t("chat.agentChanges.fileCount", { count: new Set(changes.map((change) => change.path)).size })}
          </span>
        )}
      </div>
      <SavedAgentActivity
        steps={steps}
        shellCommandApproval={shellCommandApproval}
        shellApprovalRequest={shellApprovalRequest}
        canResolveShellCommand={canResolveShellCommand}
        onResolveShellCommand={onResolveShellCommand}
        embedded
      />
      {changes.length > 0 && <AgentFileActivity changes={changes} embedded />}
    </section>
  )
}

function SavedAgentActivity({
  steps,
  shellCommandApproval,
  shellApprovalRequest,
  canResolveShellCommand,
  onResolveShellCommand,
  embedded = false,
}: {
  steps: ChatAgentStep[]
  shellCommandApproval?: ChatShellCommandApproval
  shellApprovalRequest?: ChatShellApprovalRequest
  canResolveShellCommand?: boolean
  onResolveShellCommand?: (command: string, decision: ChatShellCommandApproval["decision"], instructions?: string) => void
  embedded?: boolean
}) {
  const events = useMemo<ChatAgentEvent[]>(() => steps
    .filter((step) => step.type !== "final")
    .map((step) => ({
      stage: step.type === "understanding"
        ? "understanding"
        : step.type === "routing"
          ? "routing"
          : step.type === "tool_call"
            ? "tool_call"
            : "tool_result",
      tool: step.tool,
      toolRaw: step.toolRaw,
      query: step.query,
      message: step.message,
      count: step.count,
      status: step.status,
      timestamp: step.timestamp,
      // Preserve input/output so the click-to-expand panel in AgentActivity
      // can render the original tool parameters and result in the saved
      // history view as well as the live stream.
      input: step.input,
      output: step.output,
    })), [steps])
  const shellCommand = shellApprovalRequest?.command ?? useMemo(() => extractShellApprovalCommand(steps), [steps])
  const validApproval = shellCommand && shellCommandApproval?.command === shellCommand
    ? shellCommandApproval
    : undefined
  if (events.length === 0 && !shellCommand) return null
  return (
    <div className={embedded ? "space-y-1 border-b border-border/40 px-2 py-1.5" : "space-y-1 rounded-md border border-border/50 bg-background/50 px-2 py-1"}>
      {events.length > 0 && <SharedAgentActivity events={events} compact />}
      {shellCommand && (
        <ShellCommandApprovalCard
          command={shellCommand}
          approval={validApproval}
          request={shellApprovalRequest}
          canResolve={canResolveShellCommand}
          onResolve={onResolveShellCommand}
        />
      )}
    </div>
  )
}

function ShellCommandApprovalCard({
  command,
  approval,
  request,
  canResolve,
  onResolve,
}: {
  command: string
  approval?: ChatShellCommandApproval
  request?: ChatShellApprovalRequest
  canResolve?: boolean
  onResolve?: (command: string, decision: ChatShellCommandApproval["decision"], instructions?: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [showOther, setShowOther] = useState(false)
  const [instructions, setInstructions] = useState("")
  const pending = !approval
  const statusText = approval?.decision === "approved"
    ? t("chat.shellApproval.approved")
    : approval?.decision === "rejected"
      ? t("chat.shellApproval.rejected")
      : approval?.decision === "other"
        ? t("chat.shellApproval.otherResolved")
        : t("chat.shellApproval.pending")

  const resolve = (decision: ChatShellCommandApproval["decision"], otherInstructions?: string) => {
    if (!pending || !canResolve || !onResolve) return
    if (decision === "other" && !otherInstructions?.trim()) return
    onResolve(command, decision, otherInstructions?.trim())
    setOpen(false)
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
        <span className="flex min-w-0 items-center gap-1.5">
          <Terminal className="h-3 w-3 shrink-0" />
          <span className="truncate">{statusText}</span>
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-amber-500/15"
        >
          {t("chat.shellApproval.viewDetails")}
        </button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl gap-3" showCloseButton>
          <DialogHeader>
            <DialogTitle>{request?.classification === "hard_deny" ? t("chat.shellApproval.highRiskTitle") : t("chat.shellApproval.title")}</DialogTitle>
            <DialogDescription>{t("chat.shellApproval.description")}</DialogDescription>
            {request?.reasons.length ? <div className="flex flex-wrap gap-1">{request.reasons.map((reason) => <span key={reason} className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-800 dark:text-amber-200">{t(`chat.shellApproval.reason.${reason}`)}</span>)}</div> : null}
          </DialogHeader>
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{t("chat.shellApproval.commandLabel")}</div>
            <pre className="max-h-80 overflow-auto rounded border border-border/60 bg-muted/40 p-3 whitespace-pre-wrap break-all font-mono text-xs text-foreground">
              <code>{command}</code>
            </pre>
          </div>
          {approval?.decision === "other" && approval.instructions && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("chat.shellApproval.otherInstructions")}</div>
              <p className="rounded border border-border/60 bg-muted/40 p-2 whitespace-pre-wrap text-xs">{approval.instructions}</p>
            </div>
          )}
          {pending && canResolve && (
            <>
              {showOther && (
                <textarea
                  autoFocus
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder={t("chat.shellApproval.otherPlaceholder")}
                  rows={3}
                  className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-sm outline-none focus:border-primary"
                />
              )}
              <DialogFooter>
                {showOther ? (
                  <>
                    <Button variant="outline" onClick={() => setShowOther(false)}>{t("chat.shellApproval.back")}</Button>
                    <Button disabled={!instructions.trim()} onClick={() => resolve("other", instructions)}>{t("chat.shellApproval.continueWithOther")}</Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setShowOther(true)}>{t("chat.shellApproval.other")}</Button>
                    <Button variant="destructive" onClick={() => resolve("rejected")}>{t("chat.shellApproval.reject")}</Button>
                    <Button onClick={() => resolve("approved")}>{t("chat.shellApproval.approve")}</Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function extractShellApprovalCommand(steps: ChatAgentStep[]): string | null {
  for (const step of steps) {
    if (step.tool !== "shell_exec" || step.status !== "skipped") continue
    const message = step.message?.trim() ?? ""
    const command = message.startsWith("approval required:")
      ? message.slice("approval required:".length).trim()
      : ""
    if (command) return command
  }
  return null
}

export const ChatMessage = memo(ChatMessageImpl, (prev, next) =>
  prev.message === next.message
  && prev.isLastAssistant === next.isLastAssistant
  && prev.onRegenerate === next.onRegenerate
  && prev.onOpenReferencePreview === next.onOpenReferencePreview
  && prev.onResolveShellCommand === next.onResolveShellCommand
  && prev.onSubmitUserInput === next.onSubmitUserInput
  && prev.onOpenAnnotationDrawer === next.onOpenAnnotationDrawer
  && prev.onSaveAnnotation === next.onSaveAnnotation
)

function UserInputRequestPanel({
  request,
  onSubmit,
}: {
  request: ChatUserInputRequest
  onSubmit?: (request: ChatUserInputRequest, answers: Record<string, unknown>) => boolean
}) {
  const { t } = useTranslation()
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => initialUserInputAnswers(request))
  const [submitted, setSubmitted] = useState(false)
  const canSubmit = Boolean(onSubmit) && !submitted

  const update = useCallback((id: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [id]: value }))
  }, [])

  return (
    <div className="rounded-lg border border-primary/20 bg-background px-3 py-3 shadow-sm">
      <div className="mb-3">
        <div className="text-sm font-medium text-foreground">{request.title}</div>
        {request.description && (
          <p className="mt-1 text-xs text-muted-foreground">{request.description}</p>
        )}
      </div>
      <div className="space-y-3">
        {request.fields.map((field) => (
          <UserInputFieldControl
            key={field.id}
            field={field}
            value={answers[field.id]}
            disabled={!canSubmit}
            onChange={(value) => update(field.id, value)}
          />
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => {
            if (!canSubmit) return
            if (onSubmit?.(request, answers)) {
              setSubmitted(true)
            }
          }}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Check className="h-3.5 w-3.5" />
          {submitted ? t("chat.userInputSubmitted") : t("chat.userInputSubmit")}
        </button>
      </div>
    </div>
  )
}

function UserInputFieldControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ChatUserInputField
  value: unknown
  disabled?: boolean
  onChange: (value: unknown) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5">
      <div>
        <label className="text-xs font-medium text-foreground">{field.label}</label>
        {field.description && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{field.description}</p>
        )}
      </div>
      {field.type === "single" && (
        <div className="grid gap-1.5">
          {(field.options ?? []).map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
                value === option.value
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-muted/30 text-muted-foreground hover:bg-muted"
              } disabled:cursor-not-allowed disabled:opacity-70`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">{option.label}</span>
                {option.recommended && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                    {t("chat.userInputRecommended")}
                  </span>
                )}
              </span>
              {option.description && (
                <span className="mt-0.5 block text-[11px] opacity-80">{option.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {field.type === "multi" && (
        <div className="grid gap-1.5">
          {(field.options ?? []).map((option) => {
            const selected = Array.isArray(value) && value.includes(option.value)
            return (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors ${
                  selected ? "border-primary bg-primary/10" : "border-border bg-muted/30 hover:bg-muted"
                } ${disabled ? "cursor-not-allowed opacity-70" : ""}`}
              >
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={selected}
                  onChange={(event) => {
                    const current = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
                    onChange(event.target.checked
                      ? [...current, option.value]
                      : current.filter((item) => item !== option.value))
                  }}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-foreground">{option.label}</span>
                  {option.description && (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{option.description}</span>
                  )}
                </span>
              </label>
            )
          })}
        </div>
      )}
      {field.type === "text" && (
        <input
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary disabled:opacity-70"
        />
      )}
      {field.type === "textarea" && (
        <textarea
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          rows={4}
          className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary disabled:opacity-70"
        />
      )}
      {field.type === "confirm" && (
        <label className={`flex items-center gap-2 text-sm ${disabled ? "opacity-70" : ""}`}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={Boolean(value)}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{field.placeholder ?? t("chat.userInputEnabled")}</span>
        </label>
      )}
    </div>
  )
}

function initialUserInputAnswers(request: ChatUserInputRequest): Record<string, unknown> {
  const answers: Record<string, unknown> = {}
  for (const field of request.fields) {
    if (field.defaultValue !== undefined) {
      answers[field.id] = field.defaultValue
      continue
    }
    if (field.type === "single") {
      answers[field.id] = field.options?.find((option) => option.recommended)?.value
        ?? field.options?.[0]?.value
        ?? ""
    } else if (field.type === "multi") {
      answers[field.id] = []
    } else if (field.type === "confirm") {
      answers[field.id] = false
    } else {
      answers[field.id] = ""
    }
  }
  return answers
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    // Strip HTML comments and thinking blocks before copying
    const clean = content
      .replace(/<!--.*?-->/gs, "")
      .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
      .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "")
      .trim()

    await writeClipboardText(clean)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [content])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied!" : "Copy"}
    </button>
  )
}

function SaveToWikiButton({ content, visible }: { content: string; visible: boolean }) {
  const project = useWikiStore((s) => s.project)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (!project || saving) return
    const pp = normalizePath(project.path)
    setSaving(true)
    try {
      // Generate a unique filename for this save.
      // See `src/lib/wiki-filename.ts` — the slug is Unicode-aware
      // (so CJK titles don't collapse to empty) and the HHMMSS
      // timestamp suffix guarantees same-day saves stay distinct.
      const cleanContent = cleanAssistantContentForWikiSave(content)
      const title = titleFromCleanAssistantContent(cleanContent)
      const { date, fileName } = makeQueryFileName(title)
      const filePath = `${pp}/wiki/queries/${fileName}`

      const frontmatter = [
        "---",
        `type: query`,
        `title: "${title.replace(/"/g, '\\"')}"`,
        `created: ${date}`,
        `tags: []`,
        "---",
        "",
      ].join("\n")

      await writeFile(filePath, frontmatter + cleanContent)

      // Update index.md — append under ## Queries section
      const indexPath = `${pp}/wiki/index.md`
      let indexContent = ""
      try {
        indexContent = await readFile(indexPath)
      } catch {
        indexContent = "# Wiki Index\n\n## Queries\n"
      }
      // The wikilink target is the filename WITHOUT the `.md`
      // extension — must match `fileName` exactly (including the
      // time suffix) or the link lands on a 404.
      const linkTarget = fileName.replace(/\.md$/, "")
      const entry = `- [[queries/${linkTarget}|${title}]]`
      if (indexContent.includes("## Queries")) {
        indexContent = indexContent.replace(
          /(## Queries\n)/,
          `$1${entry}\n`
        )
      } else {
        indexContent = indexContent.trimEnd() + "\n\n## Queries\n" + entry + "\n"
      }
      await writeFile(indexPath, indexContent)

      // Append to log.md
      const logPath = `${pp}/wiki/log.md`
      let logContent = ""
      try {
        logContent = await readFile(logPath)
      } catch {
        logContent = "# Wiki Log\n\n"
      }
      const logEntry = `- ${date}: Saved query page \`${fileName}\`\n`
      await writeFile(logPath, logContent.trimEnd() + "\n" + logEntry)

      // Refresh file tree and update graph
      await refreshProjectFileTree(pp, { bumpDataVersion: true })

      setSaved(true)
      setTimeout(() => setSaved(false), 2000)

      // Full auto-ingest: extract entities, concepts, cross-references from saved content
      const llmConfig = useWikiStore.getState().llmConfig
      if (hasUsableLlm(llmConfig)) {
        const { autoIngest } = await import("@/lib/ingest")
        autoIngest(pp, filePath, llmConfig).catch((err) =>
          console.error("Failed to auto-ingest saved query:", err)
        )
      }
    } catch (err) {
      console.error("Failed to save to wiki:", err)
    } finally {
      setSaving(false)
    }
  }, [project, content, saving])

  if (!visible && !saved) return null

  return (
    <button
      type="button"
      onClick={handleSave}
      disabled={saving}
      className="self-start inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
      title="Save to wiki"
    >
      <BookmarkPlus className="h-3 w-3" />
      {saved ? "Saved!" : saving ? "Saving..." : "Save to Wiki"}
    </button>
  )
}

type CitedPage = MessageReference

const REF_TYPE_CONFIG: Record<string, { icon: typeof FileText; color: string }> = {
  entity: { icon: Users, color: "text-blue-500" },
  concept: { icon: Lightbulb, color: "text-purple-500" },
  source: { icon: BookOpen, color: "text-orange-500" },
  query: { icon: HelpCircle, color: "text-green-500" },
  synthesis: { icon: GitMerge, color: "text-red-500" },
  comparison: { icon: BarChart3, color: "text-teal-500" },
  finding: { icon: TrendingUp, color: "text-purple-500" },
  thesis: { icon: Target, color: "text-rose-500" },
  methodology: { icon: BookOpen, color: "text-teal-500" },
  overview: { icon: Layout, color: "text-yellow-500" },
  clip: { icon: Globe, color: "text-blue-400" },
  external: { icon: Globe, color: "text-sky-500" },
  anytxt: { icon: FileSearch, color: "text-emerald-500" },
  workspace: { icon: FileText, color: "text-cyan-500" },
}

function getRefType(path: string, page?: CitedPage): string {
  if (page?.kind === "workspace") return "workspace"
  if (page?.kind === "external") {
    return page.source?.toLowerCase() === "anytxt" ? "anytxt" : "external"
  }
  if (path.includes("raw/sources/")) return "clip"
  return inferWikiTypeFromPath(path) ?? "source"
}

function displayExternalPath(page: CitedPage): string {
  const raw = page.url || page.path
  if (!raw) return page.path
  if (raw.startsWith("file://")) {
    try {
      const url = new URL(raw)
      const decoded = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//.test(decoded)) return decoded.slice(1)
      if (url.hostname) return `//${url.hostname}${decoded}`
      return decoded
    } catch {
      return raw.replace(/^file:\/\//, "")
    }
  }
  return raw
}

function isAnyTxtReference(page: CitedPage): boolean {
  return page.kind === "external" && page.source?.toLowerCase() === "anytxt"
}

function referenceSourceLabel(page: CitedPage): string {
  if (isAnyTxtReference(page)) return "AnyTXT"
  if (page.kind === "workspace") return "Workspace"
  if (page.kind === "external") return page.source || "Web"
  return "Wiki"
}

function referenceLocator(page: CitedPage): string {
  if (page.kind === "external") return displayExternalPath(page)
  return page.path
}

function referenceSnippet(page: CitedPage): string {
  return page.kind === "external" ? page.snippet?.trim() ?? "" : ""
}

function projectAbsolutePath(projectPath: string, path: string): string {
  const pp = normalizePath(projectPath)
  const normalized = normalizePath(path)
  if (normalized.startsWith(`${pp}/`)) return normalized
  if (isAbsolutePath(normalized)) return normalized
  return `${pp}/${normalized.replace(/^\/+/, "")}`
}

function isAgentWorkspacePath(filePath: string): boolean {
  return normalizePath(filePath).split("/").includes("agent-workspace")
}

function isGeneratedOutputImage(filePath: string): boolean {
  const category = getFileCategory(filePath)
  return category === "image" || (getFileExtension(filePath) === "svg" && isAgentWorkspacePath(filePath))
}

/**
 * Markdown image-reference regex used to count `![](url)` occurrences
 * in cited pages AND extract the first URL (so the image-badge
 * jump button knows where to send the user). Same shape as the
 * search/pipeline regex elsewhere (kept duplicated to avoid
 * coupling — this module never wants to pull caption-pipeline
 * imports for a 3-character count).
 *
 * Group 1 captures the URL (everything inside `(...)` of the
 * markdown image syntax, no whitespace).
 */
const CITED_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g

interface CitedImageInfo {
  count: number
  /** First image URL on the page — used as the scroll target when
   *  the badge button opens the raw source. Null when count===0. */
  firstUrl: string | null
}

function CitedReferencesPanel({
  content,
  savedReferences,
  onOpenReferencePreview,
}: {
  content: string
  savedReferences?: CitedPage[]
  onOpenReferencePreview?: (preview: ChatReferencePreview, relatedPreviews?: ChatReferencePreview[]) => void
}) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const openFileInPreview = useWikiStore((s) => s.openFileInPreview)
  const setPendingScrollImageSrc = useWikiStore((s) => s.setPendingScrollImageSrc)
  const [expanded, setExpanded] = useState(false)
  const [outputsExpanded, setOutputsExpanded] = useState(false)
  /**
   * Per-cited-page image info: count + first image URL. We can't
   * hang this off `CitedPage` directly because `extractCitedPages`
   * is sync and works on the AI's text response, never seeing the
   * underlying page. So we fetch the page contents lazily here.
   * Same path → same info, so a tiny in-component map keyed by
   * path is plenty.
   */
  const [imageInfos, setImageInfos] = useState<Record<string, CitedImageInfo>>({})

  // Use saved references first (persisted with message), fall back to dynamic extraction
  const generatedOutputs = useMemo(() => (
    (savedReferences ?? []).filter((page) => page.kind === "workspace")
  ), [savedReferences])
  const citedPages = useMemo(() => {
    if (savedReferences && savedReferences.length > 0) {
      return savedReferences.filter((page) => page.kind !== "workspace")
    }
    return extractCitedPages(content)
  }, [content, savedReferences])

  // Async-fetch each cited page's content once and extract image
  // info: count + first URL. Done in parallel; failures are
  // silently treated as { count: 0, firstUrl: null } (page may
  // not exist on disk yet, e.g. a citation the LLM hallucinated).
  useEffect(() => {
    if (!project || citedPages.length === 0) return
    const pp = normalizePath(project.path)
    let cancelled = false
    Promise.all(
      citedPages.map(async (page) => {
        // Try the path verbatim first, then the same fallback set
        // the click-handler uses below — keeps "is the file on
        // disk" check consistent across the panel.
        if (page.kind === "external" || page.kind === "workspace") {
          return [page.path, { count: 0, firstUrl: null }] as const
        }
        const id = getFileName(page.path.replace(/^wiki\//, "").replace(/\.md$/, ""))
        const candidates = [
          `${pp}/${page.path}`,
          `${pp}/wiki/entities/${id}.md`,
          `${pp}/wiki/concepts/${id}.md`,
          `${pp}/wiki/sources/${id}.md`,
          `${pp}/wiki/queries/${id}.md`,
          `${pp}/wiki/synthesis/${id}.md`,
          `${pp}/wiki/comparisons/${id}.md`,
          `${pp}/wiki/${id}.md`,
        ]
        for (const candidate of candidates) {
          try {
            const text = await readFile(candidate)
            // Reset stateful regex.lastIndex by `new RegExp(...)` —
            // module-level `g` regexes carry state across calls
            // and would skip matches on the second invocation.
            const re = new RegExp(CITED_IMAGE_RE.source, CITED_IMAGE_RE.flags)
            const matches = [...text.matchAll(re)]
            const info: CitedImageInfo = {
              count: matches.length,
              firstUrl: matches.length > 0 ? matches[0][1] : null,
            }
            return [page.path, info] as const
          } catch {
            // try next candidate
          }
        }
        return [page.path, { count: 0, firstUrl: null }] as const
      }),
    ).then((entries) => {
      if (cancelled) return
      const next: Record<string, CitedImageInfo> = {}
      for (const [path, info] of entries) next[path] = info
      setImageInfos(next)
    })
    return () => {
      cancelled = true
    }
  }, [project, citedPages])

  /**
   * Open the raw source file for a page's first image and stage a
   * scroll target so the markdown preview lands on that image.
   * Mirrors the lightbox "Jump to source document" path in
   * search-view — same `findRawSourceForImage` resolver, same
   * `pendingScrollImageSrc` store handoff, same fallback to
   * opening the wiki page when no raw source is found.
   */
  const handleJumpToImageSource = useCallback(
    async (firstUrl: string, fallbackPath: string) => {
      if (!project) return
      const pp = normalizePath(project.path)
      const rawPath = await findRawSourceForImage(firstUrl, pp)
      if (rawPath) {
        try {
          const content = await readFile(rawPath)
          setPendingScrollImageSrc(imageUrlToAbsolute(firstUrl, pp))
          if (onOpenReferencePreview) {
            onOpenReferencePreview({
              title: getFileName(rawPath),
              path: rawPath,
              content,
            })
          } else {
            openFileInPreview(rawPath, content)
          }
          console.log(`[refs:image-jump] ${firstUrl} → raw source ${rawPath}`)
          return
        } catch (err) {
          console.warn(`[refs:image-jump] failed to read ${rawPath}:`, err)
        }
      }
      // Fallback: open the wiki summary itself with same scroll
      // target — at least the safety-net section will scroll into
      // view there.
      try {
        const fallbackAbsPath = projectAbsolutePath(pp, fallbackPath)
        const content = await readFile(fallbackAbsPath)
        setPendingScrollImageSrc(firstUrl)
        if (onOpenReferencePreview) {
          onOpenReferencePreview({
            title: getFileName(fallbackAbsPath),
            path: fallbackAbsPath,
            content,
          })
        } else {
          openFileInPreview(fallbackAbsPath, content)
        }
      } catch (err) {
        console.warn(`[refs:image-jump] fallback also failed:`, err)
      }
    },
    [project, setPendingScrollImageSrc, openFileInPreview, onOpenReferencePreview],
  )

  const openCitedPage = useCallback(async (page: CitedPage) => {
    if (page.kind === "workspace") {
      if (!project) return
      const pp = normalizePath(project.path)
      const workspacePath = projectAbsolutePath(pp, page.path)
      const relatedOutputPreviews = generatedOutputs.map((output) => {
        const outputPath = projectAbsolutePath(pp, output.path)
        return {
          title: output.title,
          path: outputPath,
          source: output.source ?? "Workspace",
          content: output.path === page.path ? page.snippet ?? "" : "",
          snippet: output.snippet,
        }
      })
      try {
        const category = getFileCategory(workspacePath)
        const shouldReadContent = isTextReadable(category) || category === "pdf"
        const content = shouldReadContent ? await readFile(workspacePath) : ""
        if (onOpenReferencePreview) {
          onOpenReferencePreview({
            title: page.title,
            path: workspacePath,
            source: page.source ?? "Workspace",
            content,
            snippet: page.snippet,
          }, relatedOutputPreviews)
        } else {
          openFileInPreview(workspacePath, content)
        }
      } catch (err) {
        console.warn("[chat refs] failed to open workspace reference:", err)
        if (onOpenReferencePreview) {
          onOpenReferencePreview({
            title: page.title,
            path: workspacePath,
            source: page.source ?? "Workspace",
            content: `Unable to load generated file: ${page.path}`,
            snippet: page.snippet,
          }, relatedOutputPreviews)
        }
      }
      return
    }
    if (page.kind === "external") {
      const target = page.url || page.path
      const displayPath = displayExternalPath(page)
      const previewPath = `${isAnyTxtReference(page) ? "anytxt" : "external"}-preview://${encodeURIComponent(target || page.title)}`
      const previewContent = [
        `# ${page.title}`,
        "",
        `**Source:** ${referenceSourceLabel(page)}`,
        `**Path:** ${displayPath}`,
        "",
        "## Preview",
        "",
        page.snippet?.trim() || "(No preview fragment returned.)",
      ].join("\n")
      if (onOpenReferencePreview) {
        onOpenReferencePreview({
          title: page.title,
          path: displayPath,
          source: referenceSourceLabel(page),
          external: true,
          content: previewContent,
          snippet: page.snippet ?? "",
        })
        return
      }
      if (isAnyTxtReference(page)) {
        openFileInPreview(previewPath, previewContent)
        useWikiStore.getState().setExternalPreview({
          title: page.title,
          path: previewPath,
          source: referenceSourceLabel(page),
          url: displayPath,
          snippet: page.snippet ?? "",
        })
        return
      }
      if (target) {
        await openUrl(target).catch((err) => {
          console.warn("[chat refs] failed to open external reference:", err)
        })
      }
      return
    }
    if (!project) return
    const pp = normalizePath(project.path)
    const id = getFileName(page.path.replace(/^wiki\//, "").replace(/\.md$/, ""))
    const candidates = [
      projectAbsolutePath(pp, page.path),
      `${pp}/wiki/entities/${id}.md`,
      `${pp}/wiki/concepts/${id}.md`,
      `${pp}/wiki/sources/${id}.md`,
      `${pp}/wiki/queries/${id}.md`,
      `${pp}/wiki/synthesis/${id}.md`,
      `${pp}/wiki/comparisons/${id}.md`,
      `${pp}/wiki/${id}.md`,
    ]
    for (const candidate of candidates) {
      try {
        const content = await readFile(candidate)
        if (onOpenReferencePreview) {
          onOpenReferencePreview({
            title: page.title,
            path: candidate,
            content,
          })
        } else {
          openFileInPreview(candidate, content)
        }
        return
      } catch {
        // try next
      }
    }
    const fallbackPath = projectAbsolutePath(pp, page.path)
    const fallbackContent = `Unable to load: ${page.path}`
    if (onOpenReferencePreview) {
      onOpenReferencePreview({
        title: page.title,
        path: fallbackPath,
        content: fallbackContent,
      })
    } else {
      openFileInPreview(fallbackPath, fallbackContent)
    }
  }, [project, generatedOutputs, onOpenReferencePreview, openFileInPreview])

  if (citedPages.length === 0 && generatedOutputs.length === 0) return null

  const MAX_COLLAPSED = 3
  const visiblePages = expanded ? citedPages : citedPages.slice(0, MAX_COLLAPSED)
  const visibleOutputs = outputsExpanded ? generatedOutputs : generatedOutputs.slice(0, MAX_COLLAPSED)
  const hasMore = citedPages.length > MAX_COLLAPSED
  const hasMoreOutputs = generatedOutputs.length > MAX_COLLAPSED

  return (
    <div className="space-y-1">
      {generatedOutputs.length > 0 && (
        <div className="rounded-md border border-primary/20 bg-primary/5 text-xs mb-1">
          <button
            type="button"
            onClick={() => hasMoreOutputs && setOutputsExpanded(!outputsExpanded)}
            className="flex w-full items-center gap-1.5 px-2 py-1 text-primary transition-colors hover:text-primary/80"
          >
            <Sparkles className="h-3 w-3 shrink-0" />
            <span className="font-medium">{t("chat.generatedOutputs")} ({generatedOutputs.length})</span>
            {hasMoreOutputs && (
              outputsExpanded
                ? <ChevronDown className="h-3 w-3 ml-auto" />
                : <ChevronRight className="h-3 w-3 ml-auto" />
            )}
          </button>
          <div className="px-2 pb-1.5">
            {visibleOutputs.map((page, i) => {
              const refType = getRefType(page.path, page)
              const config = REF_TYPE_CONFIG[refType] ?? REF_TYPE_CONFIG.source
              const Icon = config.icon
              const absoluteOutputPath = project ? projectAbsolutePath(project.path, page.path) : page.path
              const isImageOutput = isGeneratedOutputImage(absoluteOutputPath)
              const imageSrc = isImageOutput ? convertFileSrc(absoluteOutputPath) : null
              return (
                <div
                  key={page.path}
                  className="flex w-full items-start gap-1.5 rounded text-left"
                  title={page.path}
                >
                  <span className="mt-1 text-[10px] text-primary/60 w-4 shrink-0 text-right">[{i + 1}]</span>
                  <button
                    type="button"
                    onClick={() => openCitedPage(page)}
                    className="flex min-w-0 flex-1 items-start gap-2 rounded px-1 py-1 text-left hover:bg-primary/10 transition-colors"
                  >
                    {imageSrc ? (
                      <span className="h-14 w-20 shrink-0 overflow-hidden rounded border border-primary/20 bg-background/80">
                        <img
                          src={imageSrc}
                          alt={page.title}
                          loading="lazy"
                          className="h-full w-full object-cover"
                          onError={(event) => {
                            event.currentTarget.style.opacity = "0"
                          }}
                        />
                      </span>
                    ) : (
                      <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${config.color}`} />
                    )}
                    <span className="min-w-0 flex-1 text-foreground/90">
                      <span className="block truncate">{page.title}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/75">
                        {referenceLocator(page)}
                      </span>
                    </span>
                    <span className="shrink-0 rounded border border-primary/20 bg-background/80 px-1 py-0 text-[10px] text-primary">
                      {t("chat.generatedOutput")}
                    </span>
                  </button>
                </div>
              )
            })}
            {hasMoreOutputs && !outputsExpanded && (
              <button
                type="button"
                onClick={() => setOutputsExpanded(true)}
                className="w-full text-center text-[10px] text-primary/70 hover:text-primary pt-0.5"
              >
                +{generatedOutputs.length - MAX_COLLAPSED} more...
              </button>
            )}
          </div>
        </div>
      )}
      {citedPages.length > 0 && (
        <div className="rounded-md border border-border/60 bg-muted/30 text-xs mb-1">
          <button
            type="button"
            onClick={() => hasMore && setExpanded(!expanded)}
            className="flex w-full items-center gap-1.5 px-2 py-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <FileText className="h-3 w-3 shrink-0" />
            <span className="font-medium">{t("chat.references")} ({citedPages.length})</span>
            {hasMore && (
              expanded
                ? <ChevronDown className="h-3 w-3 ml-auto" />
                : <ChevronRight className="h-3 w-3 ml-auto" />
            )}
          </button>
          <div className="px-2 pb-1.5">
        <ReferenceKnowledgeGraph references={citedPages} onOpenReference={openCitedPage} />
        {visiblePages.map((page, i) => {
          const refType = getRefType(page.path, page)
          const config = REF_TYPE_CONFIG[refType] ?? REF_TYPE_CONFIG.source
          const Icon = config.icon
          const info = imageInfos[page.path]
          const hasImages = (info?.count ?? 0) > 0
          return (
            // Outer is a div, NOT a button — we have two click
            // targets inside (image badge + main row) and nesting
            // a button inside a button is invalid HTML and breaks
            // event delegation. Hover effect shifts to the inner
            // buttons individually so each gives feedback.
            <div
              key={page.path}
              className="flex w-full items-center gap-1.5 rounded text-left"
              title={page.kind === "external" ? `${referenceSourceLabel(page)}: ${referenceLocator(page)}` : page.path}
            >
              <span className="text-[10px] text-muted-foreground/60 w-4 shrink-0 text-right">[{i + 1}]</span>
              {/*
               * Image badge — clickable, separately from the page
               * row. Click → resolve the FIRST image's raw source
               * (`raw/sources/<slug>.<ext>`) and open the FULL
               * combined-extraction preview, scrolled to that
               * image. This mirrors the search-view lightbox
               * "Jump to source document" behavior so the two
               * surfaces feel consistent.
               *
               * Icon: lucide `Image` (picture-frame outline with
               * mountain + sun) — direct visual cue for "image",
               * NOT `Camera` which reads as "take a photo".
               */}
              {hasImages && info?.firstUrl && (
                <button
                  type="button"
                  onClick={() => handleJumpToImageSource(info.firstUrl!, page.path)}
                  className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-blue-600 hover:bg-blue-100/40 dark:text-blue-400 dark:hover:bg-blue-900/30 transition-colors"
                  title={`Open original document at first image (${info.count} image${info.count === 1 ? "" : "s"} on this page)`}
                >
                  <ImageIcon className="h-3 w-3" />
                  {info.count}
                </button>
              )}
              <button
                type="button"
                onClick={() => openCitedPage(page)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent/50 transition-colors"
              >
                <Icon className={`h-3 w-3 shrink-0 ${config.color}`} />
                <span className="min-w-0 flex-1 text-foreground/80">
                  <span className="block truncate">{page.title}</span>
                  {page.kind === "external" && (
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/75">
                      {referenceLocator(page)}
                    </span>
                  )}
                  {isAnyTxtReference(page) && referenceSnippet(page) && (
                    <span className="mt-0.5 line-clamp-2 whitespace-normal text-[10px] leading-4 text-muted-foreground">
                      {referenceSnippet(page)}
                    </span>
                  )}
                </span>
                {page.kind === "external" && (
                  <span className="shrink-0 rounded border border-border/60 bg-background/80 px-1 py-0 text-[10px] text-muted-foreground">
                    {referenceSourceLabel(page)}
                  </span>
                )}
              </button>
            </div>
          )
        })}
        {hasMore && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full text-center text-[10px] text-muted-foreground hover:text-primary pt-0.5"
          >
            +{citedPages.length - MAX_COLLAPSED} more...
          </button>
        )}
          </div>
      </div>
      )}
    </div>
  )
}


/**
 * Extract cited wiki pages from the hidden <!-- cited: 1, 3, 5 --> comment.
 * Maps page numbers back to the pages that were sent to the LLM.
 */
function extractCitedPages(text: string): CitedPage[] {
  const citedMatch = text.match(/<!--\s*cited:\s*(.+?)\s*-->/)
  if (citedMatch && lastQueryPages.length > 0) {
    const numbers = citedMatch[1]
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n >= 1 && n <= lastQueryPages.length)

    const pages = numbers.map((n) => lastQueryPages[n - 1])
    if (pages.length > 0) return pages
  }

  // Fallback: if LLM used [1], [2] notation in text, try to match those
  if (lastQueryPages.length > 0) {
    const numberRefs = text.match(/\[(\d+)\]/g)
    if (numberRefs) {
      const numbers = [...new Set(numberRefs.map((r) => parseInt(r.slice(1, -1), 10)))]
        .filter((n) => n >= 1 && n <= lastQueryPages.length)
      if (numbers.length > 0) {
        return numbers.map((n) => lastQueryPages[n - 1])
      }
    }
  }

  // Fallback for persisted messages: extract [[wikilinks]] from the text
  // Try to resolve each wikilink to a real file path by checking common wiki subdirectories
  const wikilinks = text.match(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g)
  if (wikilinks) {
    const seen = new Set<string>()
    const pages: CitedPage[] = []
    const WIKI_DIRS = ["entities", "concepts", "sources", "queries", "synthesis", "comparisons"]

    for (const link of wikilinks) {
      const nameMatch = link.match(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/)
      if (nameMatch) {
        const id = nameMatch[1].trim()
        const display = nameMatch[2]?.trim() || id

        // Skip if id contains path separators (already a path like queries/xxx)
        if (seen.has(id)) continue
        seen.add(id)

        // Try to find the file in known wiki subdirectories
        let resolvedPath = ""
        if (id.includes("/")) {
          // Already has directory like "queries/my-query"
          resolvedPath = `wiki/${id}.md`
        } else {
          // Search in common directories
          for (const dir of WIKI_DIRS) {
            resolvedPath = `wiki/${dir}/${id}.md`
            // We can't do async file checking here, so try all known patterns
            // The click handler will try multiple paths
            break // Use first candidate, click handler resolves the rest
          }
          if (!resolvedPath) resolvedPath = `wiki/${id}.md`
        }

        pages.push({ title: display, path: resolvedPath })
      }
    }
    if (pages.length > 0) return pages
  }

  // No citations found
  return []
}

interface StreamingMessageProps {
  content: string
  agentEvents?: ChatAgentEvent[]
}

export function StreamingMessage({ content, agentEvents = [] }: StreamingMessageProps) {
  const { thinking, answer } = useMemo(() => separateThinking(content), [content])
  const isThinking = thinking !== null && answer.length === 0

  return (
    <div className="flex gap-2 flex-row">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Bot className="h-4 w-4" />
      </div>
      <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
        <SharedAgentActivity events={agentEvents} />
        {isThinking ? (
          <StreamingThinkingBlock content={thinking} />
        ) : (
          <>
            {thinking && <ThinkingBlock content={thinking} />}
            <MarkdownContent content={answer} />
            <span className="animate-pulse">▊</span>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Render assistant content split into paragraphs by `splitMarkdownParagraphs`,
 * which respects fenced code blocks (``` and ~~~) so blank lines inside a fence
 * do not count as paragraph breaks. Each paragraph is wrapped in a `group relative`
 * container so the per-paragraph hover trigger remains anchored to that specific
 * paragraph. The trigger creates an annotation bound to the whole paragraph text —
 * no selection required.
 *
 * A single-paragraph message collapses to one wrapper with no visible
 * change to existing layout. Citations are still extracted from the
 * full `content` in `CitedReferencesPanel`, so the per-paragraph split
 * only affects rendering, not reference resolution.
 */
function AssistantParagraphs({ content, parentMessageId }: { content: string; parentMessageId: string }) {
  const paragraphs = splitMarkdownParagraphs(content)
  return (
    <div data-message-id={parentMessageId}>
      {paragraphs.map((p, i) => (
        <div key={i} className="group relative">
          <MarkdownContent content={p} />
          <div className="absolute right-0 top-0">
            <PerParagraphTrigger paragraph={p} parentMessageId={parentMessageId} />
          </div>
        </div>
      ))}
    </div>
  )
}

// `MarkdownContent` lives in `./MarkdownContent` so non-chat surfaces
// (e.g. `ChatAnnotationInline`) can use it without dragging in the
// graph renderer that requires WebGL2. Re-export it from this module
// so call-sites that already import `chat-message` keep working.
export { MarkdownContent }

/** Streaming thinking: shows latest ~5 lines rolling upward with animation */
function StreamingThinkingBlock({ content }: { content: string }) {
  const lines = content.split("\n").filter((l) => l.trim())
  const visibleLines = lines.slice(-5)

  return (
    <div className="rounded-md border border-dashed border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 px-2.5 py-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-sm animate-pulse">💭</span>
        <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Thinking...</span>
        <span className="text-[10px] text-amber-600/50 dark:text-amber-500/40">{lines.length} lines</span>
      </div>
      <div className="h-[5lh] overflow-hidden text-xs text-amber-800/70 dark:text-amber-300/60 font-mono leading-relaxed">
        {visibleLines.map((line, i) => (
          <div
            key={lines.length - 5 + i}
            className="truncate"
            style={{ opacity: 0.4 + (i / visibleLines.length) * 0.6 }}
          >
            {line}
          </div>
        ))}
        <span className="animate-pulse text-amber-500">▊</span>
      </div>
    </div>
  )
}

/** Completed thinking: collapsed by default, click to expand */
// `ThinkingBlock` and `WikiLink` now live next to `MarkdownContent`
// in `./MarkdownContent`. `StreamingMessage` keeps its own
// `StreamingThinkingBlock` below because it has different copy
// ("Thinking..." vs "Thought for N lines") and a per-line opacity
// fade animation tied to streaming progress.
