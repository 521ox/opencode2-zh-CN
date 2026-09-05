import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { createMemo, createSignal } from "solid-js"
import { Locale } from "../util/locale"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { usePromptStash, type StashEntry } from "../prompt/stash"
import { useI18n } from "../context/i18n"
import type { Translator } from "../i18n"

function getRelativeTime(timestamp: number, t: Translator): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return t("dialog.stash.justNow")
  if (minutes < 60) return t("dialog.stash.minutes", { count: minutes })
  if (hours < 24) return t("dialog.stash.hours", { count: hours })
  if (days < 7) return t("dialog.stash.days", { count: days })
  return Locale.datetime(timestamp)
}

function getStashPreview(input: string, maxLength: number = 50): string {
  const firstLine = input.split("\n")[0].trim()
  return Locale.truncate(firstLine, maxLength)
}

export function DialogStash(props: { onSelect: (entry: StashEntry) => void }) {
  const { t } = useI18n()
  const dialog = useDialog()
  const stash = usePromptStash()
  const theme = useTheme("elevated")
  const shortcuts = Keymap.useShortcuts()

  const [toDelete, setToDelete] = createSignal<number>()

  const options = createMemo(() => {
    const entries = stash.list()
    // Show most recent first
    return entries
      .map((entry, index) => {
        const isDeleting = toDelete() === index
        const lineCount = (entry.prompt.text.match(/\n/g)?.length ?? 0) + 1
        return {
          title: isDeleting
            ? t("dialog.stash.confirmDelete", { shortcut: shortcuts.get("stash.delete") ?? "" })
            : getStashPreview(entry.prompt.text),
          bg: isDeleting ? theme.background.action.destructive.focused : undefined,
          fg: isDeleting ? theme.text.action.destructive.focused : undefined,
          value: index,
          description: getRelativeTime(entry.timestamp, t),
          footer: lineCount > 1 ? t("dialog.stash.lines", { count: lineCount }) : undefined,
        }
      })
      .toReversed()
  })

  return (
    <DialogSelect
      title={t("dialog.stash.title")}
      options={options()}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        const entries = stash.list()
        const entry = entries[option.value]
        if (entry) {
          stash.remove(option.value)
          props.onSelect(entry)
        }
        dialog.clear()
      }}
      actions={[
        {
          command: "stash.delete",
          title: t("dialog.stash.delete"),
          onTrigger: (option) => {
            if (toDelete() === option.value) {
              stash.remove(option.value)
              setToDelete(undefined)
              return
            }
            setToDelete(option.value)
          },
        },
      ]}
    />
  )
}
