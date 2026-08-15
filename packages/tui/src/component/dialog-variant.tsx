import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useI18n } from "../context/i18n"

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()
  const { t } = useI18n()

  const options = createMemo(() =>
    local.model.variant.list().map((variant) => ({
      value: variant,
      title: variant,
      onSelect: () => {
        dialog.clear()
        local.model.variant.set(variant)
      },
    })),
  )

  return (
    <DialogSelect<string>
      options={options()}
      title={t("dialog.variant.title")}
      current={local.model.variant.current()}
      flat={true}
    />
  )
}
