import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { Keymap } from "../../../context/keymap"
import { useSessionTerminals } from "../../../context/session-terminals"
import { useI18n } from "../../../context/i18n"
import { useTheme } from "../../../context/theme"
import { useToast } from "../../../ui/toast"
import { useComposerTab } from "./index"

export function TerminalsTab(props: { sessionID: string; visibleTerminalID?: string }) {
  const composer = useComposerTab()
  const i18n = useI18n()
  const terminals = useSessionTerminals()
  const theme = useTheme()
  const toast = useToast()
  const failure = () => toast.show({ variant: "error", message: i18n.t("session.terminal.unavailable") })
  const [selected, setSelected] = createSignal<number>()
  const session = () => terminals.get(props.sessionID)
  const entries = () => session()?.terminals ?? []

  onMount(() => {
    const cleanup = composer.register({ id: "terminals", label: i18n.t("session.composer.terminals") })
    onCleanup(cleanup)
  })

  createEffect(() => {
    if (!composer.active("terminals")) return
    const index = entries().findIndex((terminal) => terminal.id === props.visibleTerminalID)
    setSelected(index < 0 ? undefined : index)
  })

  const select = () => {
    const index = selected()
    if (index === undefined) return
    const terminal = entries()[index]
    composer.close()
    if (terminal) {
      void terminals.selectTerminal(props.sessionID, terminal.id).catch(failure)
      return
    }
    void terminals.newTerminal(props.sessionID).catch(failure)
  }

  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => composer.active("terminals"),
    priority: 1,
    commands: [
      {
        id: "composer.terminal.up",
        title: i18n.t("session.composer.command.previousTerminal"),
        group: i18n.t("session.group.composer"),
        run: () => setSelected((index) => ((index ?? 0) + entries().length) % (entries().length + 1)),
      },
      {
        id: "composer.terminal.down",
        title: i18n.t("session.composer.command.nextTerminal"),
        group: i18n.t("session.group.composer"),
        run: () => setSelected((index) => ((index ?? -1) + 1) % (entries().length + 1)),
      },
      {
        id: "composer.terminal.select",
        title: i18n.t("session.composer.command.selectTerminal"),
        group: i18n.t("session.group.composer"),
        run: select,
      },
    ],
  }))

  return (
    <Show when={composer.active("terminals")}>
      <scrollbox scrollbarOptions={{ visible: false }} maxHeight={5}>
        <For each={[...entries(), undefined]}>
          {(terminal, index) => {
            const active = createMemo(() => index() === selected())
            const current = () => terminal !== undefined && terminal.id === props.visibleTerminalID
            return (
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  active()
                    ? theme.background.action.primary.focused
                    : current()
                      ? theme.background.action.primary.selected
                      : theme.background.action.primary.default
                }
                onMouseOver={() => setSelected(index())}
                onMouseUp={() => {
                  setSelected(index())
                  select()
                }}
              >
                <text
                  fg={
                    active()
                      ? theme.text.action.primary.focused
                      : current()
                        ? theme.text.action.primary.selected
                        : theme.text.action.primary.default
                  }
                  attributes={active() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                  truncate
                >
                  {terminal?.foregroundProcess ?? terminal?.title ?? `+ ${i18n.t("session.command.newTerminal")}`}
                </text>
              </box>
            )
          }}
        </For>
      </scrollbox>
    </Show>
  )
}
