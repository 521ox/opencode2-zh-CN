/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import { Keymap } from "../context/keymap"
import { useI18n } from "../context/i18n"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import { CloseButton, useDialog } from "../ui/dialog"
import { Spinner } from "./spinner"

type State =
  | { type: "ready"; active: "update" | "skip" }
  | { type: "installing" }
  | { type: "restarting" }
  | { type: "failed"; message: string }

export function DialogUpdate(props: {
  dialogKey: string
  version: string
  install: () => Promise<void>
  restart?: () => Promise<void>
}) {
  const dialog = useDialog()
  const i18n = useI18n()
  const theme = useTheme("elevated")
  const [state, setState] = createSignal<State>({ type: "ready", active: "update" })
  const close = () => {
    if (dialog.key === props.dialogKey) dialog.clear()
  }

  const install = async () => {
    setState({ type: "installing" })
    await props.install()
    if (props.restart) {
      setState({ type: "restarting" })
      await props.restart()
    }
    close()
  }

  const beginInstall = () => {
    if (state().type !== "ready") return
    void install().catch((error) => setState({ type: "failed", message: errorMessage(error) }))
  }

  const run = () => {
    const current = state()
    if (current.type !== "ready") return
    if (current.active === "skip") return close()
    beginInstall()
  }

  const toggle = () =>
    setState((current) =>
      current.type === "ready" ? { ...current, active: current.active === "update" ? "skip" : "update" } : current,
    )

  const selected = (action: "update" | "skip") => {
    const current = state()
    return current.type === "ready" && current.active === action
  }

  const failure = () => {
    const current = state()
    return current.type === "failed" ? current.message : ""
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: i18n.t("dialog.update.command.confirm"),
        group: i18n.t("dialog.group"),
        run: () => (state().type === "failed" ? close() : run()),
      },
      {
        bind: "left",
        title: i18n.t("dialog.update.command.previous"),
        group: i18n.t("dialog.group"),
        run: toggle,
      },
      {
        bind: "right",
        title: i18n.t("dialog.update.command.next"),
        group: i18n.t("dialog.group"),
        run: toggle,
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.default}>
          {i18n.t("dialog.update.title")}
        </text>
        <CloseButton onClose={close} />
      </box>
      <box paddingBottom={1}>
        <Switch>
          <Match when={state().type === "ready"}>
            <text fg={theme.text.subdued}>
              {i18n.t(props.restart ? "dialog.update.description.managed" : "dialog.update.description.manual")}
            </text>
          </Match>
          <Match when={state().type === "installing"}>
            <Spinner shimmer={theme.text.default}>{i18n.t("dialog.update.installing", { version: props.version })}</Spinner>
          </Match>
          <Match when={state().type === "restarting"}>
            <Spinner shimmer={theme.text.default}>{i18n.t("dialog.update.restarting")}</Spinner>
          </Match>
          <Match when={state().type === "failed"}>
            <text fg={theme.text.feedback.error.default}>{failure()}</text>
          </Match>
        </Switch>
      </box>
      <Show
        when={state().type === "ready"}
        fallback={
          <Show when={state().type === "failed"}>
            <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
              <box
                paddingLeft={3}
                paddingRight={3}
                backgroundColor={theme.background.action.primary.focused}
                onMouseUp={close}
              >
                <text fg={theme.text.action.primary.focused}>{i18n.t("dialog.update.close")}</text>
              </box>
            </box>
          </Show>
        }
      >
        <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
          <For each={["skip", "update"] as const}>
            {(action) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={selected(action) ? theme.background.action.primary.focused : undefined}
                onMouseUp={() => {
                  if (action === "skip") return close()
                  beginInstall()
                }}
              >
                <text fg={selected(action) ? theme.text.action.primary.focused : theme.text.subdued}>
                  {i18n.t(action === "update" ? "dialog.update.action.update" : "dialog.update.action.skip")}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
