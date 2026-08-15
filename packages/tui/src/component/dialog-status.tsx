import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useData } from "../context/data"
import { For, Match, Switch, Show, createMemo } from "solid-js"
import { useI18n } from "../context/i18n"

export function DialogStatus() {
  const data = useData()
  const theme = useTheme("elevated")
  const dialog = useDialog()
  const { t } = useI18n()

  const mcp = createMemo(() => data.location.mcp.server.list() ?? [])
  const color = (status: string) => {
    if (status === "connected") return theme.text.feedback.success.default
    if (status === "failed") return theme.text.feedback.error.default
    if (status === "needs_auth") return theme.text.feedback.warning.default
    return theme.text.subdued
  }
  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.default} attributes={TextAttributes.BOLD}>
          {t("dialog.status.title")}
        </text>
        <text fg={theme.text.subdued} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={mcp().length > 0} fallback={<text fg={theme.text.default}>{t("dialog.status.empty")}</text>}>
        <box>
          <text fg={theme.text.default}>
            {t(mcp().length === 1 ? "dialog.status.server.one" : "dialog.status.server.other", { count: mcp().length })}
          </text>
          <For each={mcp()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} style={{ fg: color(item.status.status) }}>
                  •
                </text>
                <text fg={theme.text.default} wrapMode="word">
                  <b>{item.name}</b>{" "}
                  <span style={{ fg: theme.text.subdued }}>
                    <Switch fallback={item.status.status}>
                      <Match when={item.status.status === "connected"}>{t("dialog.status.connected")}</Match>
                      <Match when={item.status.status === "failed" && item.status}>{(val) => val().error}</Match>
                      <Match when={item.status.status === "disabled"}>{t("dialog.status.disabledInConfiguration")}</Match>
                      <Match when={item.status.status === "needs_auth"}>{t("dialog.status.needsAuthentication")}</Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
