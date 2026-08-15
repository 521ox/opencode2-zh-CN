import { createMemo } from "solid-js"
import { useTuiPaths } from "../../context/runtime"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { abbreviateHome } from "../../util/path-format"
import { SessionQuestion } from "./permission"
import { usePromptMove } from "../../component/prompt/move"
import { useI18n } from "../../context/i18n"

export function SessionLocationMissing(props: { directory: string; projectID: string; sessionID: string }) {
  const move = usePromptMove({ projectID: () => props.projectID, sessionID: () => props.sessionID })
  return <SessionLocationUnavailable directory={props.directory} onMove={move.open} />
}

export function SessionLocationUnavailable(props: { directory: string; onMove: () => void }) {
  const paths = useTuiPaths()
  const theme = useTheme("elevated")
  const i18n = useI18n()
  const directory = createMemo(() => Locale.truncateMiddle(abbreviateHome(props.directory, paths.home), 72))

  return (
    <SessionQuestion
      id="session.location-missing"
      group={i18n.t("session.location.recovery")}
      choicesLabel={i18n.t("session.location.recoveryActions")}
      instance={props.directory}
      title={i18n.t("session.location.unavailable")}
      body={
        <box paddingLeft={1} gap={1}>
          <text fg={theme.text.subdued}>{directory()}</text>
          <text fg={theme.text.default}>{i18n.t("session.location.chooseDirectory")}</text>
        </box>
      }
      options={{ move: i18n.t("session.location.chooseDirectoryAction") }}
      onSelect={props.onMove}
    />
  )
}
