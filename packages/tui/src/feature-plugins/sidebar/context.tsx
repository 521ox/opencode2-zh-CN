import { Plugin } from "@opencode-ai/plugin/tui"
import { createMemo, Show } from "solid-js"
import { contextUsage } from "../../util/session"
import { useI18n } from "../../context/i18n"

export function SidebarContext(props: { context: Plugin.Context; sessionID: string }) {
  const i18n = useI18n()
  const theme = props.context.theme
  const msg = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))
  const money = createMemo(
    () =>
      new Intl.NumberFormat(i18n.locale(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const state = createMemo(() =>
    contextUsage(msg(), props.context.data.location.model.list(session()?.location), session()?.revert?.messageID),
  )

  return (
    <Show when={state() || cost() > 0}>
      <box>
        <text fg={theme.text.default}>
          <b>{i18n.t("feature.sidebar.context.title")}</b>
        </text>
        <Show when={state()}>
          {(value) => (
            <>
              <text fg={theme.text.subdued}>
                {i18n.t("feature.sidebar.context.tokens", { count: value().tokens.toLocaleString(i18n.locale()) })}
              </text>
              <Show when={value().percent !== undefined}>
                <text fg={theme.text.subdued}>{i18n.t("feature.sidebar.context.used", { percent: value().percent! })}</text>
              </Show>
            </>
          )}
        </Show>
        <Show when={cost() > 0}>
          <text fg={theme.text.subdued}>{i18n.t("feature.sidebar.context.spent", { cost: money().format(cost()) })}</text>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "internal:sidebar-context",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarContext context={context} sessionID={props.sessionID} />,
    })
  },
})
