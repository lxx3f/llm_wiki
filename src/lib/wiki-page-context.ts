import { isAbsolutePath, normalizePath } from "@/lib/path-utils"

export type WikiWriteMode = "confirm" | "direct"

function relativeWikiMarkdown(projectPath: string, path: string): string | null {
  const root = normalizePath(projectPath).replace(/\/+$/g, "")
  const candidate = normalizePath(path).replace(/^\/+/, "")
  const relative = isAbsolutePath(candidate)
    ? candidate.startsWith(`${root}/`) ? candidate.slice(root.length + 1) : null
    : candidate
  if (!relative || !/^wiki\/(?!\.)[^/]+(?:\/[^/]+)*\.md$/i.test(relative)) return null
  if (relative.split("/").some((part) => part.startsWith("."))) return null
  return relative
}

export function getWikiContextFiles(
  projectPath: string,
  automaticFile: string | null,
  manualFiles: string[],
): string[] {
  return Array.from(new Set([
    ...(automaticFile ? [automaticFile] : []),
    ...manualFiles,
  ].map((path) => relativeWikiMarkdown(projectPath, path)).filter((path): path is string => path !== null)))
}
