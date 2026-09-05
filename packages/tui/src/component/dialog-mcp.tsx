import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useData } from "../context/data"
import { useClient } from "../context/client"
import { Keymap } from "../context/keymap"
import { pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { McpServer } from "@opencode-ai/client"
import { useToast } from "../ui/toast"
import { DialogErrorDetails } from "./dialog-error-details"
import { DialogIntegration } from "./dialog-integration"
import { useLocation } from "../context/location"
import { useI18n } from "../context/i18n"

function statusError(status: McpServer["status"]) {
  if (status.status === "failed") return status.error
  return undefined
}

function Status(props: { status: McpServer["status"]; loading: boolean }) {
  const { t } = useI18n()
  if (props.loading || props.status.status === "pending") {
    return <>{t("dialog.mcp.status.connecting")}</>
  }
  if (props.status.status === "connected") {
    return <span style={{ attributes: TextAttributes.BOLD }}>{t("dialog.mcp.status.connected")} ✓</span>
  }
  if (props.status.status === "failed") {
    return <>{t("dialog.mcp.status.failed")} !</>
  }
  if (props.status.status === "needs_auth") {
    return <>{t("dialog.mcp.status.signInRequired")} →</>
  }
  return <>{t("dialog.mcp.status.disabled")} ○</>
}

export function DialogMcp(props: { initialServer?: string; details?: boolean } = {}) {
  const data = useData()
  const dialog = useDialog()
  const client = useClient()
  const location = useLocation()
  const toast = useToast()
  const { t } = useI18n()
  const theme = useTheme("elevated")
  const current = () => location.ref ?? data.location.default()
  const servers = createMemo(() =>
    pipe(
      data.location.mcp.server.list(current()) ?? [],
      sortBy((server) => server.name),
    ),
  )
  const initial = props.initialServer ? servers().find((server) => server.name === props.initialServer) : undefined
  const [focused, setFocused] = createSignal<string | undefined>(props.initialServer)
  const [detail, setDetail] = createSignal<McpServer | undefined>(
    props.details && initial?.status.status === "failed" ? initial : undefined,
  )
  const [loading, setLoading] = createSignal<string | null>(null)

  const statusColor = (status: McpServer["status"]) => {
    if (status.status === "connected") return theme.text.feedback.success.default
    if (status.status === "failed") return theme.text.feedback.error.default
    if (status.status === "needs_auth") return theme.text.feedback.warning.default
    return theme.text.subdued
  }

  createEffect(() => {
    if (focused()) return
    const first = servers()[0]
    if (first) setFocused(first.name)
  })

  const options = createMemo(() => {
    const loadingMcp = loading()
    return servers().map((server) => {
      const pending = loadingMcp === server.name || server.status.status === "pending"
      return {
        value: server.name,
        title: server.name,
        footer: <Status status={server.status} loading={pending} />,
        footerColor: pending ? theme.text.subdued : statusColor(server.status),
      }
    })
  })

  const focusedServer = createMemo(() => servers().find((server) => server.name === focused()))

  const toggleTitle = createMemo(() => {
    const status = focusedServer()?.status.status
    if (status === "connected") return t("dialog.mcp.action.disconnect")
    if (status === "failed") return t("dialog.mcp.action.retry")
    if (status === "needs_auth") return t("dialog.mcp.action.signIn")
    return t("dialog.mcp.action.connect")
  })

  const focusedError = createMemo(() => {
    const server = focusedServer()
    return server ? statusError(server.status) : undefined
  })

  const select = (name: string | undefined) => {
    const server = servers().find((entry) => entry.name === name)
    if (!server) return
    if (server.status.status === "needs_auth" && server.integrationID) {
      dialog.replace(() => <DialogIntegration integrationID={server.integrationID} autoConnect />)
      return
    }
    if (!statusError(server.status)) return
    setDetail(server)
  }

  // Auth-gated servers enter the integration flow; other inactive states retry the connection.
  // The mcp.status.changed event refreshes the list, so no manual sync is needed.
  const toggle = (name: string) => {
    if (loading() !== null) return
    const server = servers().find((entry) => entry.name === name)
    if (!server || server.status.status === "pending") return
    if (server.status.status === "needs_auth" && server.integrationID) {
      select(name)
      return
    }
    setLoading(name)
    const target = current()
    const input = { server: name, location: { directory: target.directory, workspace: target.workspaceID } }
    const call = server.status.status === "connected" ? client.api.mcp.disconnect(input) : client.api.mcp.connect(input)
    void call.catch(toast.error).finally(() => setLoading(null))
  }

  return (
    <box>
      <Show
        when={detail()}
        fallback={
          <DialogSelect
            title={t("dialog.mcp.title")}
            options={options()}
            preserveSelection
            onMove={(option) => setFocused(option.value as string)}
            onSelect={(option) => select(option.value as string)}
            actions={[
              {
                title: toggleTitle(),
                command: "dialog.mcp.toggle",
                onTrigger: (option) => {
                  setFocused(option.value as string)
                  toggle(option.value as string)
                },
              },
            ]}
            footer={
              <Show when={focusedError()}>
                <text fg={theme.text.subdued}>{t("dialog.mcp.viewError")}</text>
              </Show>
            }
          />
        }
      >
        {(server) => (
          <DialogErrorDetails
            title={t("dialog.mcp.serverTitle", { name: server().name })}
            error={statusError(server().status) ?? t("dialog.mcp.unknownConnectionError")}
            context={t("dialog.mcp.errorContext", {
              config: `mcp.servers.${server().name}`,
              integration: server().integrationID
                ? t("dialog.mcp.integration", { id: server().integrationID ?? "" })
                : "",
            })}
            onBack={() => {
              setDetail(undefined)
              dialog.setSize("medium")
            }}
          />
        )}
      </Show>
    </box>
  )
}
