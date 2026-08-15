import { TextAttributes } from "@opentui/core"
import { Keymap } from "../context/keymap"
import { useI18n } from "../context/i18n"
import { useTheme } from "../context/theme"
import { DialogCloseButton, useDialog } from "./dialog"

export function DialogHelp() {
  const dialog = useDialog()
  const { t } = useI18n()
  const theme = useTheme("elevated")
  const shortcuts = Keymap.useShortcuts()

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: t("ui.dialog.help.close"), group: t("ui.group.dialog"), run: () => dialog.clear() },
      { bind: "escape", title: t("ui.dialog.help.close"), group: t("ui.group.dialog"), run: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.default}>
          {t("ui.dialog.help.title")}
        </text>
        <DialogCloseButton />
      </box>
      <box paddingBottom={1}>
        <text fg={theme.text.subdued}>
          {t("ui.dialog.help.description", { shortcut: shortcuts.get("command.palette.show") ?? "" })}
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme.background.action.primary.focused}
          onMouseUp={() => dialog.clear()}
        >
          <text fg={theme.text.action.primary.focused}>{t("ui.action.ok")}</text>
        </box>
      </box>
    </box>
  )
}
