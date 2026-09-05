import { onCleanup } from "solid-js"
import { useI18n } from "../context/i18n"
import { useThemes } from "../context/theme"
import { useToast } from "../ui/toast"

export function ThemeErrorToast() {
  const { t } = useI18n()
  const themes = useThemes()
  const toast = useToast()

  onCleanup(
    themes.onError(({ name, error }) =>
      toast.show({
        variant: "error",
        title: t("ui.theme.loadFailed", { name }),
        message: error.message,
      }),
    ),
  )

  return null
}
