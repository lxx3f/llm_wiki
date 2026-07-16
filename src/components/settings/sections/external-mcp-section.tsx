import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Server, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  createMiniMaxTokenPlanServer,
  normalizeExternalMcpConfig,
  type ExternalMcpConfig,
  type ExternalMcpEnvironmentVariable,
  type ExternalMcpServerConfig,
} from "@/lib/external-mcp-config"
import { saveExternalMcpConfig } from "@/lib/project-store"
import { useWikiStore } from "@/stores/wiki-store"

const ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

function createCustomServer(existing: ExternalMcpServerConfig[]): ExternalMcpServerConfig {
  let index = existing.length + 1
  let id = `mcp_server_${index}`
  while (existing.some((server) => server.id === id)) {
    index += 1
    id = `mcp_server_${index}`
  }

  return {
    id,
    displayName: `MCP Server ${index}`,
    enabled: false,
    transport: { type: "stdio", command: "", args: [], environment: [] },
    limits: {
      startupTimeoutSeconds: 15,
      toolTimeoutSeconds: 60,
      maxCallsPerRun: 8,
      maxOutputBytes: 65536,
    },
  }
}

function updateServer(
  config: ExternalMcpConfig,
  id: string,
  update: (server: ExternalMcpServerConfig) => ExternalMcpServerConfig,
): ExternalMcpConfig {
  return { ...config, servers: config.servers.map((server) => server.id === id ? update(server) : server) }
}

function isReady(server: ExternalMcpServerConfig): boolean {
  return Boolean(
    ID_PATTERN.test(server.id) &&
    server.displayName.trim() &&
    server.transport.command.trim() &&
    server.transport.args.every((arg) => arg.trim()) &&
    server.transport.environment.every((entry) => ENVIRONMENT_NAME_PATTERN.test(entry.name.trim())),
  )
}

export function ExternalMcpSection() {
  const { t } = useTranslation()
  const persistedConfig = useWikiStore((state) => state.externalMcpConfig)
  const setExternalMcpConfig = useWikiStore((state) => state.setExternalMcpConfig)
  const [config, setConfig] = useState<ExternalMcpConfig>(persistedConfig)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setConfig(persistedConfig)
  }, [persistedConfig])

  const enabledServers = useMemo(
    () => config.servers.filter((server) => server.enabled).length,
    [config.servers],
  )

  const persist = useCallback(async (nextConfig: ExternalMcpConfig) => {
    const normalized = normalizeExternalMcpConfig({
      ...nextConfig,
      enabled: nextConfig.servers.some((server) => server.enabled),
    })
    setSaving(true)
    setError(null)
    try {
      await saveExternalMcpConfig(normalized)
      setExternalMcpConfig(normalized)
      setConfig(normalized)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }, [setExternalMcpConfig])

  const addMiniMax = useCallback(() => {
    setConfig((current) => {
      if (current.servers.some((server) => server.id === "minimax_token_plan")) return current
      const server = createMiniMaxTokenPlanServer()
      setExpanded(server.id)
      return { ...current, servers: [...current.servers, server] }
    })
  }, [])

  const addCustom = useCallback(() => {
    setConfig((current) => {
      const server = createCustomServer(current.servers)
      setExpanded(server.id)
      return { ...current, servers: [...current.servers, server] }
    })
  }, [])

  const saveServer = useCallback(async (server: ExternalMcpServerConfig) => {
    if (!isReady(server)) {
      setError(t("settings.sections.externalMcp.validation", {
        defaultValue: "Enter a valid server ID, display name, command, arguments, and environment variable names before saving.",
      }))
      return
    }
    await persist({
      enabled: config.enabled,
      servers: config.servers,
    })
  }, [config, persist, t])

  const toggleServer = useCallback((server: ExternalMcpServerConfig, enabled: boolean) => {
    if (enabled && !window.confirm(t("settings.sections.externalMcp.enableConfirm", {
      defaultValue: "Enable this MCP server? Its tools may run commands and all enabled server tools can be automatically executed by the Agent.",
    }))) {
      return
    }
    setConfig((current) => updateServer(current, server.id, (item) => ({ ...item, enabled })))
  }, [t])

  const setServer = useCallback((id: string, update: (server: ExternalMcpServerConfig) => ExternalMcpServerConfig) => {
    setError(null)
    setConfig((current) => updateServer(current, id, update))
  }, [])

  const removeServer = useCallback((id: string) => {
    const nextConfig = {
      ...config,
      enabled: config.servers.filter((server) => server.id !== id).some((server) => server.enabled),
      servers: config.servers.filter((server) => server.id !== id),
    }
    setConfig(nextConfig)
    void persist(nextConfig)
    if (expanded === id) setExpanded(null)
  }, [config, expanded, persist])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.externalMcp.title", { defaultValue: "External MCP Servers" })}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.externalMcp.description", { defaultValue: "Connect stdio MCP servers that the Agent can use alongside built-in tools." })}
        </p>
      </div>

      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-100">
        <div className="flex gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t("settings.sections.externalMcp.securityNotice", { defaultValue: "Environment values, including API keys, are stored in plain text in app settings. Enabled server tools can be executed automatically by the Agent. Only add servers and commands you trust." })}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
        <div>
          <div className="text-sm font-medium">{t("settings.sections.externalMcp.summary", { defaultValue: "{{enabled}} enabled / {{total}} configured", enabled: enabledServers, total: config.servers.length })}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.sections.externalMcp.saveHint", { defaultValue: "Save each server after editing. Changes are written to the local app settings." })}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={addMiniMax} disabled={config.servers.some((server) => server.id === "minimax_token_plan")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t("settings.sections.externalMcp.addMiniMax", { defaultValue: "Add MiniMax template" })}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={addCustom}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t("settings.sections.externalMcp.addCustom", { defaultValue: "Add custom server" })}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {config.servers.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          <Server className="mx-auto mb-2 h-5 w-5 opacity-50" />
          {t("settings.sections.externalMcp.empty", { defaultValue: "No external MCP servers configured. Add a trusted server to get started." })}
        </div>
      ) : (
        <div className="space-y-3">
          {config.servers.map((server) => {
            const open = expanded === server.id
            return (
              <div key={server.id} className={`rounded-md border ${server.enabled ? "border-primary/40" : ""}`}>
                <div className="flex items-center gap-3 p-3">
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setExpanded(open ? null : server.id)} aria-expanded={open}>
                    {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                    <span className="truncate font-medium">{server.displayName || server.id}</span>
                    <code className="hidden rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">{server.id}</code>
                  </button>
                  <label className="flex shrink-0 items-center gap-2 text-xs">
                    <input type="checkbox" checked={server.enabled} onChange={(event) => toggleServer(server, event.target.checked)} className="h-4 w-4" />
                    {server.enabled ? t("settings.sections.externalMcp.enabled", { defaultValue: "Enabled" }) : t("settings.sections.externalMcp.disabled", { defaultValue: "Disabled" })}
                  </label>
                </div>

                {open && (
                  <div className="space-y-4 border-t p-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label={t("settings.sections.externalMcp.displayName", { defaultValue: "Display name" })} value={server.displayName} onChange={(displayName) => setServer(server.id, (item) => ({ ...item, displayName }))} />
                      <Field label={t("settings.sections.externalMcp.serverId", { defaultValue: "Server ID" })} value={server.id} onChange={(id) => setServer(server.id, (item) => ({ ...item, id }))} hint={t("settings.sections.externalMcp.serverIdHint", { defaultValue: "Lowercase letters, numbers, and underscores." })} />
                    </div>
                    <Field label={t("settings.sections.externalMcp.command", { defaultValue: "Command" })} value={server.transport.command} onChange={(command) => setServer(server.id, (item) => ({ ...item, transport: { ...item.transport, command } }))} placeholder="npx" />
                    <Field label={t("settings.sections.externalMcp.arguments", { defaultValue: "Arguments" })} value={server.transport.args.join("\n")} onChange={(value) => setServer(server.id, (item) => ({ ...item, transport: { ...item.transport, args: value.split("\n").map((arg) => arg.trim()).filter(Boolean) } }))} hint={t("settings.sections.externalMcp.argumentsHint", { defaultValue: "One argument per line. Arguments are passed directly to the command." })} multiline />
                    <Field label={t("settings.sections.externalMcp.workingDirectory", { defaultValue: "Working directory" })} value={server.transport.workingDirectory ?? ""} onChange={(workingDirectory) => setServer(server.id, (item) => {
                      const { workingDirectory: _previousWorkingDirectory, ...transport } = item.transport
                      return {
                        ...item,
                        transport: {
                          ...transport,
                          ...(workingDirectory.trim() ? { workingDirectory } : {}),
                        },
                      }
                    })} hint={t("settings.sections.externalMcp.workingDirectoryHint", { defaultValue: "Optional. Leave blank to inherit the app working directory." })} />

                    <EnvironmentEditor environment={server.transport.environment} onChange={(environment) => setServer(server.id, (item) => ({ ...item, transport: { ...item.transport, environment } }))} />

                    <div className="flex items-center justify-between gap-3 border-t pt-3">
                      <Button type="button" variant="destructive" size="sm" onClick={() => removeServer(server.id)}>
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        {t("settings.sections.externalMcp.delete", { defaultValue: "Delete server" })}
                      </Button>
                      <Button type="button" size="sm" disabled={saving} onClick={() => void saveServer(server)}>
                        {saving ? t("settings.sections.externalMcp.saving", { defaultValue: "Saving…" }) : t("settings.sections.externalMcp.save", { defaultValue: "Save server" })}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Field({ label, value, onChange, hint, placeholder, multiline = false }: { label: string; value: string; onChange: (value: string) => void; hint?: string; placeholder?: string; multiline?: boolean }) {
  return <div className="space-y-1.5">
    <Label>{label}</Label>
    {multiline ? <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={3} className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring" /> : <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />}
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
}

function EnvironmentEditor({ environment, onChange }: { environment: ExternalMcpEnvironmentVariable[]; onChange: (environment: ExternalMcpEnvironmentVariable[]) => void }) {
  const { t } = useTranslation()
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-3">
      <div>
        <Label>{t("settings.sections.externalMcp.environment", { defaultValue: "Environment variables" })}</Label>
        <p className="mt-1 text-xs text-muted-foreground">{t("settings.sections.externalMcp.environmentHint", { defaultValue: "Values are stored as plain text. Use these for API keys or server-specific settings." })}</p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => onChange([...environment, { name: "", value: "" }])}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        {t("settings.sections.externalMcp.addEnvironment", { defaultValue: "Add variable" })}
      </Button>
    </div>
    {environment.map((entry, index) => <div key={`${index}-${entry.name}`} className="flex gap-2">
      <Input value={entry.name} onChange={(event) => onChange(environment.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} placeholder="NAME" className="font-mono" />
      <Input type="password" value={entry.value} onChange={(event) => onChange(environment.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} placeholder={t("settings.sections.externalMcp.value", { defaultValue: "Value" })} />
      <Button type="button" variant="ghost" size="icon" onClick={() => onChange(environment.filter((_, itemIndex) => itemIndex !== index))} aria-label={t("settings.sections.externalMcp.removeEnvironment", { defaultValue: "Remove variable" })}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>)}
  </div>
}
