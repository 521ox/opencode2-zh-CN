import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../keymap"
import type { BuiltinTuiPlugin } from "../builtins"

const id = "internal:scrap"
const route = "scrap"

function Scrap(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()

  useBindings(() => ({
    bindings: [
      {
        key: "escape",
        desc: "Back home",
        group: "Scrap",
        cmd() {
          props.api.route.navigate("home")
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background}>
      <box flexGrow={1} />
      <box
        height={1}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
      >
        <text fg={theme.textMuted}>~/code/anomalyco/opencode</text>
        <box flexGrow={1} />
        <text fg={theme.textMuted}>esc home</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([{ name: route, render: () => <Scrap api={api} /> }])
  api.keymap.registerLayer({
    commands: [
      {
        name: "app.scrap",
        title: "Open scrap screen",
        category: "Debug",
        namespace: "palette",
        run() {
          api.route.navigate(route)
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = { id, tui }

export default plugin
