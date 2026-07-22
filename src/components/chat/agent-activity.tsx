import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { BookOpen, Check, ChevronRight, FileSearch, GitMerge, Globe, Layout, Sparkles, Target } from "lucide-react"
import type { ChatAgentEvent, ChatAgentEventStage, ChatAgentStep } from "@/lib/chat-agent-types"

function derivePreview(tool: string, output: string): string | null {
  if (!output) return null
  const normalizedTool = tool.replace(/^mcp\.[^.]+\./, "")

  if (["wiki.search", "source.search", "graph.search", "web.search", "anytxt.search"].includes(normalizedTool)) {
    const numbered = output.match(/^\d+\.\s+(.+)$/m)
    if (numbered) return `→ ${numbered[1]}`
    const first = output.split("\n").find((line) => line.trim().length > 0)
    return first ? `→ ${first}` : null
  }

  if (normalizedTool === "shell.exec") {
    let inStdout = false
    for (const line of output.split("\n")) {
      if (line.startsWith("stdout:")) {
        inStdout = true
        continue
      }
      if (line.startsWith("stderr:") || line.startsWith("Generated files:")) break
      if (inStdout && line.trim().length > 0) return `→ ${truncateForPreview(line, 120)}`
    }
    return null
  }

  if (normalizedTool === "wiki.read_page" || normalizedTool === "skill.read_file") {
    const heading = output.match(/^#+\s+(.+)$/m)
    return heading ? `→ ${heading[1]}` : null
  }

  if (normalizedTool === "workspace.read_file") {
    const heading = output.match(/^#+\s+(.+)$/m)
    if (heading) return `→ ${heading[1]}`
    const first = output.split("\n").find((line) => line.trim().length > 0)
    return first ? `→ ${first.replace(/^\s*\d+\s+/, "")}` : null
  }

  if (normalizedTool === "wiki.edit_page" || normalizedTool === "workspace.edit_file") {
    const match = output.match(/^edited\s+(\S+)/m)
    return match ? `→ ${match[1]}` : null
  }

  return null
}

function truncateForPreview(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

export function AgentActivity({ events, compact = false }: { events: ChatAgentEvent[]; compact?: boolean }) {
  const { t } = useTranslation()
  const visible = useMemo(() => {
    const merged: ChatAgentEvent[] = []
    for (const event of events) {
      const last = merged[merged.length - 1]
      if (event.stage === "tool_result" && last && last.stage === "tool_call" && last.tool === event.tool && (last.query ?? "") === (event.query ?? "")) {
        merged[merged.length - 1] = {
          ...last,
          toolRaw: last.toolRaw ?? event.toolRaw,
          status: event.status ?? last.status,
          output: event.output ?? last.output,
          timestamp: event.timestamp ?? last.timestamp,
          count: event.count ?? last.count,
        }
        continue
      }
      merged.push(event)
    }
    return merged.filter((event, index, items) => {
      const previous = items[index - 1]
      return !previous || previous.stage !== event.stage || previous.query !== event.query || previous.tool !== event.tool || previous.message !== event.message
    })
  }, [events])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  if (visible.length === 0) return null

  return (
    <div className={`${compact ? "" : "mb-2 border-b border-border/40 pb-2"} flex flex-col gap-1.5`}>
      {visible.map((event, index) => {
        const active = index === visible.length - 1
        const Icon = agentStageIcon(event.stage)
        const key = `${event.stage}-${event.tool ?? ""}-${event.query ?? ""}-${index}`
        const expandable = Boolean(event.input || event.output)
        const isOpen = expanded[key] === true
        const preview = event.output && event.tool ? derivePreview(event.tool, event.output) : null
        return (
          <div key={key}>
            <button type="button" onClick={() => expandable && setExpanded((previous) => ({ ...previous, [key]: !previous[key] }))} disabled={!expandable} aria-expanded={expandable ? isOpen : undefined} className={`flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left text-xs transition-colors ${active ? "text-foreground" : "text-muted-foreground"} ${expandable ? "hover:bg-muted/40 cursor-pointer" : "cursor-default"}`}>
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center ${active ? "text-primary/70" : "text-muted-foreground/60"}`}><Icon className={`h-3.5 w-3.5 ${active ? "animate-pulse" : ""}`} /></span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate">{event.toolRaw && <code className="mr-1.5 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground" title={t("chat.tool.name", { defaultValue: "Tool name" })}>{event.toolRaw}</code>}{event.message || t(`chat.agent.${event.stage}`)}{event.query && <span className="text-muted-foreground"> · {event.query}</span>}{typeof event.count === "number" && <span className="text-muted-foreground"> · {t("chat.agent.resultCount", { count: event.count })}</span>}</span>{preview && <span className="truncate text-[11px] text-muted-foreground/80" title={preview}>{preview}</span>}</span>
              {event.timestamp && <time className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>}
              {expandable && <ChevronRight className={`h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden />}
            </button>
            {isOpen && <div className="ml-6 mt-1 flex flex-col gap-2 rounded border border-border/40 bg-muted/30 p-2 text-[11px]" data-testid="tool-detail-panel">
              {event.input && <ToolDetail title={t("chat.tool.parameters", { defaultValue: "Parameters" })} value={event.input} />}
              {event.output && <ToolDetail title={t("chat.tool.output", { defaultValue: "Result" })} value={event.output} error={event.status === "error"} />}
              {!event.output && event.status === "running" && <div className="text-muted-foreground">{t("chat.tool.running", { defaultValue: "Running…" })}</div>}
            </div>}
          </div>
        )
      })}
    </div>
  )
}

function ToolDetail({ title, value, error = false }: { title: string; value: string; error?: boolean }) {
  return <div><div className="font-medium text-muted-foreground">{title}</div><pre className={`mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded p-1.5 font-mono ${error ? "border border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-300" : "bg-background/60"}`}>{value}</pre></div>
}

export function SavedAgentActivity({ steps, compact = true }: { steps: ChatAgentStep[]; compact?: boolean }) {
  const events = useMemo<ChatAgentEvent[]>(() => steps.filter((step) => step.type !== "final").map((step) => ({
    stage: step.type === "understanding" ? "understanding" : step.type === "routing" ? "routing" : step.type === "tool_call" ? "tool_call" : "tool_result",
    tool: step.tool, toolRaw: step.toolRaw, query: step.query, message: step.message, count: step.count,
    status: step.status, timestamp: step.timestamp, input: step.input, output: step.output,
  })), [steps])
  return events.length > 0 ? <AgentActivity events={events} compact={compact} /> : null
}

function agentStageIcon(stage: ChatAgentEventStage) {
  switch (stage) {
    case "understanding": return Target
    case "tool_call": return Sparkles
    case "tool_result": return Check
    case "searching_wiki": return BookOpen
    case "searching_graph": return GitMerge
    case "searching_web": return Globe
    case "searching_anytxt": return FileSearch
    case "reading_context": return Layout
    case "writing": return Sparkles
    case "routing": default: return Sparkles
  }
}
