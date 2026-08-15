import { TextAttributes } from "@opentui/core"
import { Keymap } from "../context/keymap"
import { useI18n } from "../context/i18n"
import { useTheme } from "../context/theme"
import { CloseButton, useDialog, type DialogContext } from "./dialog"

export function DialogExportResult(props: { path: string; onClose?: () => void }) {
  const dialog = useDialog()
  const { t } = useI18n()
  const theme = useTheme("elevated")

  const close = () => {
    props.onClose?.()
    dialog.clear()
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: t("ui.dialog.export.closeResult"),
        group: t("ui.group.dialog"),
        run: close,
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.default}>
          {t("ui.dialog.export.sessionExported")}
        </text>
        <CloseButton onClose={close} />
      </box>
      <box>
        <text fg={theme.text.default}>{props.path}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme.background.action.primary.focused}
          onMouseUp={close}
        >
          <text fg={theme.text.action.primary.focused}>{t("ui.action.close")}</text>
        </box>
      </box>
    </box>
  )
}

DialogExportResult.show = (dialog: DialogContext, path: string) =>
  new Promise<void>((resolve) => {
    dialog.replace(() => <DialogExportResult path={path} onClose={resolve} />, resolve)
  })
