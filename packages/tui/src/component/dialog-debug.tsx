import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogCloseButton, useDialog } from "../ui/dialog"
import { useRoute } from "../context/route"
import { useLocal } from "../context/local"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { describeOS, describeTerminal } from "../util/system"
import { useTuiApp } from "../context/runtime"
import { useI18n } from "../context/i18n"

export function DialogDebug() {
  const theme = useTheme()
  const dialog = useDialog()
  const route = useRoute()
  const local = useLocal()
  const clipboard = useClipboard()
  const toast = useToast()
  const app = useTuiApp()
  const { t } = useI18n()
  const [copied, setCopied] = createSignal(false)

  dialog.setSize("large")

  const entries = createMemo(() => {
    const model = local.model.current()
    return [
      { label: t("dialog.debug.version"), value: `${app.version} (${app.channel})` },
      { label: t("dialog.debug.date"), value: new Date().toISOString() },
      { label: t("dialog.debug.os"), value: describeOS() },
      { label: t("dialog.debug.terminal"), value: describeTerminal() },
      { label: t("dialog.debug.sessionID"), value: route.data.type === "session" ? route.data.sessionID : t("dialog.debug.notAvailable") },
      { label: t("dialog.debug.model"), value: model ? `${model.providerID}/${model.modelID}` : t("dialog.debug.notAvailable") },
    ]
  })

  const copy = () => {
    const text = entries()
      .map((entry) => `${entry.label}: ${entry.value}`)
      .join("\n")
    void clipboard
      .write(text)
      .then(() => {
        setCopied(true)
        toast.show({ message: t("dialog.debug.copiedToClipboard"), variant: "info" })
      })
      .catch(toast.error)
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [{ bind: "return", title: t("dialog.debug.copyCommand"), group: t("dialog.group"), run: copy }],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.default} attributes={TextAttributes.BOLD}>
          {t("dialog.debug.title")}
        </text>
        <DialogCloseButton />
      </box>
      {/* No click-to-copy here: releasing a mouse selection must trigger the
          global copy-on-select so users can copy a single value, e.g. the session id. */}
      <box>
        <For each={entries()}>
          {(entry) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={theme.text.subdued}>
                {entry.label.padEnd(10)}
              </text>
              <text fg={theme.text.default} wrapMode="word">
                {entry.value}
              </text>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.subdued}>{t("dialog.debug.description")}</text>
        <text onMouseUp={copy}>
          <span style={{ fg: copied() ? theme.text.feedback.success.default : theme.text.default }}>
            <b>{copied() ? `✓ ${t("dialog.debug.copied")}` : t("dialog.debug.copy")}</b>{" "}
          </span>
          <span style={{ fg: theme.text.subdued }}>enter</span>
        </text>
      </box>
    </box>
  )
}
