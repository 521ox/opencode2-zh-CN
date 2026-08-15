import { useTheme } from "../context/theme"
import { useI18n } from "../context/i18n"

export function PluginRouteMissing(props: { id: string; name: string; onHome: () => void }) {
  const theme = useTheme()
  const { t } = useI18n()

  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
      <text fg={theme.text.feedback.warning.default}>
        {t("ui.pluginRoute.unknown", { route: `${props.id}/${props.name}` })}
      </text>
      <box
        onMouseUp={props.onHome}
        backgroundColor={theme.background.action.primary.hovered}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.text.action.primary.hovered}>{t("ui.pluginRoute.goHome")}</text>
      </box>
    </box>
  )
}
