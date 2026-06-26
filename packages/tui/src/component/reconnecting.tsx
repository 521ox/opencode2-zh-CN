import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { Spinner } from "./spinner"

export function Reconnecting(props: { attempt: number; error?: string }) {
  const theme = useTheme().theme

  return (
    <box
      position="absolute"
      zIndex={10_000}
      top={0}
      right={0}
      bottom={0}
      left={0}
      backgroundColor={theme.background}
      alignItems="center"
      justifyContent="center"
    >
      <box width={54} maxWidth="90%" flexDirection="column" alignItems="center" gap={1}>
        <text fg={theme.text}>Connection lost</text>
        <Spinner color={theme.textMuted}>Reconnecting to server...</Spinner>
        <text fg={theme.textMuted}>Attempt {props.attempt}</text>
        <Show when={props.error}>
          <text fg={theme.error} wrapMode="word">
            {props.error}
          </text>
        </Show>
      </box>
    </box>
  )
}
