import { useCallback, useEffect, useRef, useState } from "react"
import { MessageSquare } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { getWikiContextFiles } from "@/lib/wiki-page-context"
import { IconSidebar } from "./icon-sidebar"
import { UpdateBanner } from "./update-banner"
import { SidebarPanel } from "./sidebar-panel"
import { ContentArea } from "./content-area"
import { ResearchPanel } from "./research-panel"
import { ActivityPanel } from "./activity-panel"
import { WikiPageAssistant } from "@/components/chat/wiki-page-assistant"
import { useResearchStore } from "@/stores/research-store"
import { ErrorBoundary } from "@/components/error-boundary"
import { getAppLayoutVisibility } from "./app-layout-visibility"
import { syncRightPanelWithResearch, type RightPanel } from "./app-layout-right-panel"

interface AppLayoutProps {
  onSwitchProject: () => void
}

export function AppLayout({ onSwitchProject }: AppLayoutProps) {
  const project = useWikiStore((s) => s.project)
  const activeView = useWikiStore((s) => s.activeView)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const researchPanelOpen = useResearchStore((s) => s.panelOpen)
  const setResearchPanelOpen = useResearchStore((s) => s.setPanelOpen)
  const [rightPanel, setRightPanel] = useState<RightPanel>(() => researchPanelOpen ? "research" : "none")
  const [leftWidth, setLeftWidth] = useState(220)
  const [rightWidth, setRightWidth] = useState(400)
  const isDraggingLeft = useRef(false)
  const isDraggingRight = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setRightPanel((current) => syncRightPanelWithResearch(current, researchPanelOpen, isStreaming))
  }, [researchPanelOpen, isStreaming])

  const loadFileTree = useCallback(async () => {
    if (!project) return
    await refreshProjectFileTree(project.path, {
      projectId: project.id,
      clearDisplayTreeFirst: true,
    })
  }, [project])

  useEffect(() => {
    loadFileTree()
  }, [loadFileTree])

  const startDrag = useCallback(
    (side: "left" | "right") => (e: React.MouseEvent) => {
      e.preventDefault()
      if (side === "left") isDraggingLeft.current = true
      else isDraggingRight.current = true
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
      document.body.dataset.panelResizing = "true"

      const handleMouseMove = (event: MouseEvent) => {
        if (!containerRef.current) return
        const rect = containerRef.current.getBoundingClientRect()

        if (isDraggingLeft.current) {
          const newWidth = event.clientX - rect.left
          setLeftWidth(Math.max(150, Math.min(400, newWidth)))
        }
        if (isDraggingRight.current) {
          const newWidth = rect.right - event.clientX
          setRightWidth(Math.max(250, Math.min(rect.width * 0.5, newWidth)))
        }
      }

      const handleMouseUp = () => {
        isDraggingLeft.current = false
        isDraggingRight.current = false
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
        delete document.body.dataset.panelResizing
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
      }

      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
    },
    [],
  )

  const wikiAutomaticPagePath = project && selectedFile
    ? getWikiContextFiles(project.path, selectedFile, []).length > 0 ? selectedFile : null
    : null
  const { showLeftPanel, hasRightPanel } = getAppLayoutVisibility(activeView, rightPanel !== "none")
  const canOpenPageAssistant = activeView === "wiki" && (rightPanel === "none" || rightPanel === "research")
  const openPageAssistant = () => {
    setResearchPanelOpen(false)
    setRightPanel("assistant")
  }
  const closePageAssistant = () => setRightPanel("none")

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        <IconSidebar onSwitchProject={onSwitchProject} />
        <div ref={containerRef} className="relative flex min-w-0 flex-1 overflow-hidden">
          {showLeftPanel && (
            <>
              <div className="flex shrink-0 flex-col overflow-hidden border-r" style={{ width: leftWidth }}>
                <div className="flex-1 overflow-hidden"><SidebarPanel /></div>
                <ActivityPanel />
              </div>
              <div
                className="w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40"
                onMouseDown={startDrag("left")}
              />
            </>
          )}

          <div className="min-w-0 flex-1 overflow-hidden">
            <ErrorBoundary><ContentArea /></ErrorBoundary>
          </div>

          {canOpenPageAssistant && (
            <button
              type="button"
              onClick={openPageAssistant}
              className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded border bg-background px-2 py-1 text-xs text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Page assistant
            </button>
          )}

          {hasRightPanel && (
            <>
              <div
                className="w-1.5 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/30 active:bg-primary/40"
                onMouseDown={startDrag("right")}
              />
              <div className="flex shrink-0 flex-col overflow-hidden border-l" style={{ width: rightWidth }}>
                <ErrorBoundary>
                  {rightPanel === "assistant" ? (
                    <WikiPageAssistant automaticPagePath={wikiAutomaticPagePath} onClose={closePageAssistant} />
                  ) : <ResearchPanel />}
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
