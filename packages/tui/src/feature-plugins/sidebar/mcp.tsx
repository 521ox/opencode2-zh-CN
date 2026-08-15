import { Plugin } from "@opencode-ai/plugin/tui"
import { createMemo, For, Match, Show, Switch, createSignal } from "solid-js"
import { useI18n } from "../../context/i18n"

function View(props: { context: Plugin.Context; sessionID: string }) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(true)
  const theme = props.context.theme
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const list = createMemo(() => props.context.data.location.mcp.server.list(session()?.location) ?? [])
  const on = createMemo(() => list().filter((item) => item.status.status === "connected").length)
  const bad = createMemo(
    () => list().filter((item) => item.status.status === "failed" || item.status.status === "needs_auth").length,
  )
  const summary = createMemo(() => {
    if (!bad()) return i18n.t("feature.sidebar.mcp.active", { count: on() })
    return i18n.t(
      bad() === 1 ? "feature.sidebar.mcp.activeWithErrors.one" : "feature.sidebar.mcp.activeWithErrors.other",
      { connected: on(), errors: bad() },
    )
  })

  const dot = (status: string) => {
    if (status === "connected") return theme.text.feedback.success.default
    if (status === "failed") return theme.text.feedback.error.default
    if (status === "disabled") return theme.text.subdued
    if (status === "needs_auth") return theme.text.feedback.warning.default
    return theme.text.subdued
  }

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme.text.default}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme.text.default}>
            <b>MCP</b>
            <Show when={!open()}>
              <span style={{ fg: theme.text.subdued }}>
                {" "}
                ({summary()})
              </span>
            </Show>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  style={{
                    fg: dot(item.status.status),
                  }}
                >
                  •
                </text>
                <text fg={theme.text.default} wrapMode="word">
                  {item.name}{" "}
                  <span style={{ fg: theme.text.subdued }}>
                    <Switch fallback={item.status.status}>
                      <Match when={item.status.status === "connected"}>{i18n.t("feature.sidebar.mcp.status.connected")}</Match>
                      <Match when={item.status.status === "failed"}>
                        <i>{item.status.status === "failed" ? item.status.error : undefined}</i>
                      </Match>
                      <Match when={item.status.status === "disabled"}>{i18n.t("feature.sidebar.mcp.status.disabled")}</Match>
                      <Match when={item.status.status === "needs_auth"}>{i18n.t("feature.sidebar.mcp.status.needsAuth")}</Match>
                    </Switch>
                  </span>
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "internal:sidebar-mcp",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <View context={context} sessionID={props.sessionID} />,
    })
  },
})
