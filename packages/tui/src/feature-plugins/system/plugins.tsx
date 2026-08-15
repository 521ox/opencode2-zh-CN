import { Plugin } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { usePlugin } from "../../plugin/context"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { DialogErrorDetails } from "../../component/dialog-error-details"
import { useI18n } from "../../context/i18n"

const id = "opencode.plugins"

function View(props: { context: Plugin.Context; plugins: ReturnType<typeof usePlugin> }) {
  const i18n = useI18n()
  const [locked, setLocked] = createSignal(false)
  const [focused, setFocused] = createSignal<string>()
  const [detail, setDetail] = createSignal<{ title: string; error: string }>()
  const dialog = useDialog()
  const options = createMemo(() => {
    const builtins = props.plugins
      .registered()
      .filter((plugin) => plugin.id !== id && plugin.source === "builtin")
      .map(
        (plugin): DialogSelectOption<string> => ({
          title: plugin.id,
          value: plugin.id,
          category: i18n.t("feature.plugins.category.builtIn"),
          footer: i18n.t(plugin.active ? "feature.plugins.status.active" : "feature.plugins.status.inactive"),
          footerColor: plugin.active
            ? props.context.theme.text.feedback.success.default
            : props.context.theme.text.subdued,
        }),
      )
    const external = props.plugins
      .list()
      .filter((plugin) => plugin.status !== "unsupported")
      .map(
        (plugin): DialogSelectOption<string> => ({
          title: plugin.id ?? plugin.target,
          value: plugin.id ?? plugin.target,
          category: i18n.t("feature.plugins.category.external"),
          searchText: plugin.target,
          footer: i18n.t(
            plugin.status === "active"
              ? "feature.plugins.status.active"
              : plugin.status === "inactive"
                ? "feature.plugins.status.inactive"
                : "feature.plugins.status.failed",
          ),
          footerColor:
            plugin.status === "active"
              ? props.context.theme.text.feedback.success.default
              : plugin.status === "failed"
                ? props.context.theme.text.feedback.error.default
                : props.context.theme.text.subdued,
        }),
      )
    return [...builtins, ...external].sort((a, b) => a.title.localeCompare(b.title))
  })

  const failure = (value: string | undefined) =>
    props.plugins.list().find((plugin) => {
      if (plugin.status !== "failed") return false
      return (plugin.id ?? plugin.target) === value
    })

  createEffect(() => {
    if (focused()) return
    const first = options()[0]
    if (first) setFocused(first.value)
  })

  const toggle = (plugin: DialogSelectOption<string>) => {
    if (locked()) return
    const current = props.plugins.registered().find((item) => item.id === plugin.value)
    if (!current) return
    setLocked(true)
    void (current.active ? props.plugins.deactivate(current.id) : props.plugins.activate(current.id))
      .then((ok) => {
        if (ok) return
        props.context.ui.toast.show({ variant: "error", message: i18n.t("feature.plugins.updateFailed", { id: current.id }) })
      })
      .catch((error) => {
        props.context.ui.toast.show({
          variant: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => setLocked(false))
  }

  const select = (plugin: DialogSelectOption<string>) => {
    const failed = failure(plugin.value)
    if (!failed || failed.status !== "failed") return toggle(plugin)
    setDetail({ title: failed.target, error: failed.error })
  }

  return (
    <box>
      <Show
        when={detail()}
        fallback={
          <DialogSelect
            title={i18n.t("feature.plugins.title")}
            options={options()}
            locked={locked()}
            preserveSelection={true}
            onMove={(option) => setFocused(option.value)}
            actions={[
              {
                title: i18n.t("feature.plugins.action.toggle"),
                command: "plugins.toggle",
                disabled: (option) => {
                  const failed = failure(option?.value)
                  return Boolean(failed && !("id" in failed && failed.id))
                },
                onTrigger: toggle,
              },
            ]}
            onSelect={select}
            footer={
              <Show when={failure(focused())}>
                <text fg={props.context.theme.text.subdued}>{i18n.t("feature.plugins.viewError")}</text>
              </Show>
            }
          />
        }
      >
        {(item) => (
          <DialogErrorDetails
            title={i18n.t("feature.plugins.errorDetails", { title: item().title })}
            error={item().error}
            onBack={() => {
              setDetail()
              dialog.setSize("medium")
            }}
          />
        )}
      </Show>
    </box>
  )
}

function Commands(props: { context: Plugin.Context }) {
  const i18n = useI18n()
  const plugins = usePlugin()
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "plugins.list",
        title: i18n.t("feature.plugins.command.list"),
        group: i18n.t("feature.plugins.group"),
        slash: { name: "plugins" },
        palette: true,
        run() {
          props.context.ui.dialog.show(() => <View context={props.context} plugins={plugins} />)
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id,
  setup(context) {
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
