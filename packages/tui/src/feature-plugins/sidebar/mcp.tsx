import { Plugin } from "@opencode-ai/plugin/tui"
import type { MouseEvent } from "@opentui/core"
import { createMemo, For, Show, createSignal } from "solid-js"
import { DialogMcp } from "../../component/dialog-mcp"
import { useI18n } from "../../context/i18n"

const LEFT_MOUSE_BUTTON = 0

export function SidebarMcp(props: { context: Plugin.Context; sessionID: string }) {
  const [open, setOpen] = createSignal(true)
  const i18n = useI18n()
  const theme = props.context.theme
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const list = createMemo(() => props.context.data.location.mcp.server.list(session()?.location) ?? [])
  const on = createMemo(() => list().filter((item) => item.status.status === "connected").length)
  const bad = createMemo(
    () => list().filter((item) => item.status.status === "failed" || item.status.status === "needs_auth").length,
  )
  let armed: { server: string; down: MouseEvent } | undefined
  const dot = (status: string) => {
    if (status === "connected") return theme.text.feedback.success.default
    if (status === "failed") return theme.text.feedback.error.default
    if (status === "disabled") return theme.text.subdued
    if (status === "needs_auth") return theme.text.feedback.warning.default
    return theme.text.subdued
  }
  const summary = () => {
    if (bad() === 0) return i18n.t("feature.sidebar.mcp.active", { count: on() })
    return i18n.t(
      bad() === 1 ? "feature.sidebar.mcp.activeWithErrors.one" : "feature.sidebar.mcp.activeWithErrors.other",
      { connected: on(), errors: bad() },
    )
  }
  const statusLabel = (status: string) => {
    if (status === "connected") return i18n.t("feature.sidebar.mcp.status.connected")
    if (status === "pending") return i18n.t("feature.sidebar.mcp.status.pending")
    if (status === "failed") return i18n.t("feature.sidebar.mcp.status.failed")
    if (status === "disabled") return i18n.t("feature.sidebar.mcp.status.disabled")
    if (status === "needs_auth") return i18n.t("feature.sidebar.mcp.status.needsAuth")
    return status
  }

  return (
    <Show when={list().length > 0}>
      <box
        onMouseDown={(event) => {
          if (armed?.down !== event) armed = undefined
        }}
        onMouseUp={() => (armed = undefined)}
      >
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme.text.default}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme.text.default}>
            <b>MCP</b>
            <Show when={!open()}>
              <span style={{ fg: theme.text.subdued }}> ({summary()})</span>
            </Show>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(item) => {
              const disarm = () => {
                if (armed?.server === item.name) armed = undefined
              }
              return (
                <box flexDirection="row" gap={1} minWidth={0}>
                  <text
                    flexShrink={0}
                    style={{
                      fg: dot(item.status.status),
                    }}
                  >
                    •
                  </text>
                  <text fg={theme.text.default} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                    <b>{item.name}</b>
                  </text>
                  <Show when={statusLabel(item.status.status)}>
                    {(label) => (
                      <text
                        fg={item.status.status === "failed" ? theme.text.feedback.error.default : theme.text.subdued}
                        wrapMode="none"
                        flexShrink={0}
                        selectable={false}
                        onMouseDown={(event) => {
                          armed = event.button === LEFT_MOUSE_BUTTON ? { server: item.name, down: event } : undefined
                        }}
                        onMouseDrag={disarm}
                        onMouseDragEnd={disarm}
                        onMouseOut={disarm}
                        onMouseScroll={disarm}
                        onMouseUp={(event) => {
                          const open =
                            armed?.server === item.name && event.button === LEFT_MOUSE_BUTTON && !event.isDragging
                          armed = undefined
                          if (!open) return
                          props.context.ui.dialog.show(() => (
                            <DialogMcp initialServer={item.name} details={item.status.status === "failed"} />
                          ))
                        }}
                      >
                        {label()}
                      </text>
                    )}
                  </Show>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.mcp",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarMcp context={context} sessionID={props.sessionID} />,
    })
  },
})
