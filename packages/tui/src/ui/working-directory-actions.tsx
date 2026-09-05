import { createSignal } from "solid-js"
import open from "open"
import { useRenderer } from "@opentui/solid"
import { useClipboard } from "../context/clipboard"
import { useI18n } from "../context/i18n"
import { useDialog } from "./dialog"
import { DialogSelect } from "./dialog-select"
import { useToast } from "./toast"

export function useWorkingDirectoryActions(input: { directory: () => string | undefined; onMove?: () => void }) {
  const clipboard = useClipboard()
  const i18n = useI18n()
  const dialog = useDialog()
  const renderer = useRenderer()
  const toast = useToast()
  const [hovered, setHovered] = createSignal(false)

  function openMenu() {
    if (renderer.getSelection()?.getSelectedText()) return
    const directory = input.directory()
    if (!directory) return
    dialog.replace(() => (
      <DialogSelect
        title={i18n.t("ui.workingDirectory.title")}
        renderFilter={false}
        options={[
          {
            title: i18n.t("ui.workingDirectory.copyPath"),
            value: "location.copy",
            description: directory,
            onSelect: (dialog) => {
              void clipboard.write(directory).then(() => {
                dialog.clear()
                toast.show({ message: i18n.t("ui.workingDirectory.pathCopied"), variant: "info" })
              }, toast.error)
            },
          },
          {
            title: i18n.t("ui.workingDirectory.openFolder"),
            value: "location.open",
            description: i18n.t("ui.workingDirectory.systemFileManager"),
            onSelect: (dialog) => {
              dialog.clear()
              void open(directory).catch(toast.error)
            },
          },
          ...(input.onMove
            ? [
                {
                  title: i18n.t("ui.prompt.moveSession"),
                  value: "session.move",
                  description: i18n.t("ui.workingDirectory.anotherDirectory"),
                  onSelect: () => void input.onMove?.(),
                },
              ]
            : []),
        ]}
      />
    ))
  }

  return {
    hovered,
    onMouseOver: () => setHovered(true),
    onMouseOut: () => setHovered(false),
    onMouseUp: openMenu,
  }
}
