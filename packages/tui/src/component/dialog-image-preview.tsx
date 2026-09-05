import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { useI18n } from "../context/i18n"
import { DialogCloseButton, useDialog } from "../ui/dialog"

type ImagePreviewItem = Readonly<{
  uri: string
  mention?: Readonly<{ text: string }>
}>

export function DialogImagePreview(props: { images: readonly ImagePreviewItem[]; initial: number }) {
  const dialog = useDialog()
  const { t } = useI18n()
  const dimensions = useTerminalDimensions()
  const theme = useTheme("elevated")
  const [index, setIndex] = createSignal(Math.max(0, Math.min(props.images.length - 1, props.initial)))
  const [failed, setFailed] = createSignal(false)
  const current = createMemo(() => props.images[index()])
  const imageHeight = createMemo(() => Math.max(3, dimensions().height - 8))

  dialog.setSize("xlarge")
  dialog.setCentered(true)

  function move(direction: number) {
    if (props.images.length < 2) return
    setFailed(false)
    setIndex((value) => (value + direction + props.images.length) % props.images.length)
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "left", title: t("dialog.imagePreview.previousCommand"), group: t("dialog.group"), run: () => move(-1) },
      { bind: "right", title: t("dialog.imagePreview.nextCommand"), group: t("dialog.group"), run: () => move(1) },
    ],
  }))

  return (
    <box id="prompt-image-viewer" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.default}>
          {t("dialog.imagePreview.title", { index: index() + 1, count: props.images.length })}
        </text>
        <DialogCloseButton />
      </box>
      <image
        id="prompt-image-viewer-image"
        source={current().uri}
        fit="fit"
        protocol="auto"
        width="100%"
        height={imageHeight()}
        onError={() => setFailed(true)}
      />
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.subdued} onMouseUp={() => move(-1)}>
          {props.images.length > 1 ? `← ${t("dialog.imagePreview.previous")}` : ""}
        </text>
        <text fg={failed() ? theme.text.feedback.error.default : theme.text.subdued} wrapMode="none" truncate>
          {failed()
            ? t("dialog.imagePreview.none")
            : (current().mention?.text ?? t("dialog.imagePreview.label", { index: index() + 1 }))}
        </text>
        <text fg={theme.text.subdued} onMouseUp={() => move(1)}>
          {props.images.length > 1 ? `${t("dialog.imagePreview.next")} →` : ""}
        </text>
      </box>
    </box>
  )
}
