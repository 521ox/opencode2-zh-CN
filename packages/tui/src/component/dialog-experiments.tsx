import { createMemo, createSignal } from "solid-js"
import { useConfig } from "../config"
import { DialogSelect } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useI18n } from "../context/i18n"

type Experiment = {
  id: string
  title: "dialog.experiments.tabScroll.title"
  description: "dialog.experiments.tabScroll.description"
}

// In-flight features anyone can opt into. Each entry is temporary: an
// experiment either graduates (delete the entry, make the behavior
// unconditional) or dies (delete the entry and the branch it gated).
export const experiments: Experiment[] = [
  {
    id: "tab_scroll",
    title: "dialog.experiments.tabScroll.title",
    description: "dialog.experiments.tabScroll.description",
  },
]

export function DialogExperiments() {
  const config = useConfig()
  const theme = useTheme()
  const toast = useToast()
  const { t } = useI18n()
  const [selected, setSelected] = createSignal<Experiment>()
  const [saving, setSaving] = createSignal(false)

  const enabled = (experiment: Experiment) => config.data.experimental?.[experiment.id] === true

  const options = createMemo(() =>
    experiments.map((experiment) => ({
      title: t(experiment.title),
      searchText: t(experiment.description),
      footer: enabled(experiment) ? t("dialog.experiments.on") : t("dialog.experiments.off"),
      value: experiment,
    })),
  )

  // All experiments are booleans, so either direction toggles.
  async function change(experiment = selected()) {
    if (saving()) return
    if (!experiment) return
    const next = !enabled(experiment)
    setSaving(true)
    await config
      .update((draft) => {
        if (!draft.experimental || typeof draft.experimental !== "object") draft.experimental = {}
        draft.experimental[experiment.id] = next
      })
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  return (
    <DialogSelect
      title={t("dialog.experiments.title")}
      options={options()}
      renderFilter={experiments.length > 0}
      onMove={(option) => setSelected(option.value)}
      onSelect={(option) => void change(option.value)}
      emptyView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.text.subdued}>{t("dialog.experiments.empty")}</text>
        </box>
      }
      footerHints={experiments.length > 0 ? [{ title: "←/→", label: t("dialog.experiments.change") }] : []}
      bindings={
        experiments.length > 0
          ? [
              {
                bind: "left",
                title: t("dialog.experiments.previousValue"),
                group: t("dialog.experiments.title"),
                run: () => void change(),
              },
              {
                bind: "right",
                title: t("dialog.experiments.nextValue"),
                group: t("dialog.experiments.title"),
                run: () => void change(),
              },
            ]
          : []
      }
    />
  )
}
