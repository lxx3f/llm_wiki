import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import type { CloseBehavior } from "@/stores/wiki-store"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const CLOSE_BEHAVIORS: Array<{ value: CloseBehavior; labelKey: string; hintKey: string }> = [
  {
    value: "ask",
    labelKey: "settings.sections.general.closeAsk",
    hintKey: "settings.sections.general.closeAskHint",
  },
  {
    value: "minimize",
    labelKey: "settings.sections.general.closeMinimize",
    hintKey: "settings.sections.general.closeMinimizeHint",
  },
  {
    value: "exit",
    labelKey: "settings.sections.general.closeExit",
    hintKey: "settings.sections.general.closeExitHint",
  },
]

export function GeneralSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.general.title", { defaultValue: "General" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.general.description", {
            defaultValue: "Startup and window behavior for the desktop app.",
          })}
        </p>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={draft.autostart}
          onChange={(e) => setDraft("autostart", e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <div className="space-y-1">
          <span className="text-sm">
            {t("settings.sections.general.autostart", { defaultValue: "Launch at system startup" })}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.general.autostartHint", {
              defaultValue: "Starts LLM Wiki automatically after you sign in to this computer.",
            })}
          </p>
        </div>
      </label>

      <div className="space-y-2">
        <Label>{t("settings.sections.general.closeBehavior", { defaultValue: "When closing the window" })}</Label>
        <div className="grid gap-2">
          {CLOSE_BEHAVIORS.map((option) => {
            const active = draft.closeBehavior === option.value
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setDraft("closeBehavior", option.value)}
                className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary/30"
                    : "border-border hover:bg-accent"
                }`}
              >
                <span className="font-medium">{t(option.labelKey)}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t(option.hintKey)}
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.general.closeBehaviorHint", {
            defaultValue: "This setting applies when you click the title-bar close button. The tray menu can still quit the app directly.",
          })}
        </p>
      </div>

      <label className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
        <input
          type="checkbox"
          checked={draft.unlimitedAgentIterations}
          onChange={(e) => setDraft("unlimitedAgentIterations", e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <div className="space-y-1">
          <span className="text-sm font-medium">
            {t("settings.sections.general.unlimitedAgentIterations", {
              defaultValue: "Remove the Agent tool-call cap (power users)",
            })}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.general.unlimitedAgentIterationsHint", {
              defaultValue:
                "Lets a single Agent turn run up to ~200 tool calls regardless of mode. Use this for long multi-page wiki drafts. The stream idle timeout and Stop button still bound the run, so a misbehaving model is still safe to interrupt.",
            })}
          </p>
        </div>
      </label>

      <label className="flex items-start gap-2 rounded-md border border-sky-500/40 bg-sky-500/5 p-3">
        <input
          type="checkbox"
          checked={draft.enhancedShellMode}
          onChange={(e) => setDraft("enhancedShellMode", e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <div className="space-y-1">
          <span className="text-sm font-medium">
            {t("settings.sections.general.enhancedShellMode", {
              defaultValue: "Enhanced shell mode (code-agent style)",
            })}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.general.enhancedShellModeHint", {
              defaultValue:
                "Lets the Agent run common development tools (python, pip, uv, git, rg, grep, cat, node, npm, cargo, etc.) without per-call approval prompts, including commands that reference external files such as Python libraries under site-packages. Network clients (curl, wget, ssh), privilege escalation (sudo), destructive system paths (/etc/, C:\\Windows, rm -rf /), and shell substitution always require approval regardless. The 30-second timeout and 20K character output cap still apply.",
            })}
          </p>
        </div>
      </label>
    </div>
  )
}
