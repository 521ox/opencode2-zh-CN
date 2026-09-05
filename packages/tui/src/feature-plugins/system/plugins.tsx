import type { PluginInfo } from "@opencode-ai/client"
import { Plugin } from "@opencode-ai/plugin/tui"
import path from "node:path"
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { DialogErrorDetails } from "../../component/dialog-error-details"
import { Spinner } from "../../component/spinner"
import { usePlugin } from "../../plugin/context"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { useI18n } from "../../context/i18n"

const id = "opencode.plugins"

type Entry =
  | { readonly key: string; readonly runtime: "server"; readonly internal: boolean; readonly plugin: PluginInfo }
  | {
      readonly key: string
      readonly runtime: "tui"
      readonly internal: boolean
      readonly id?: string
      readonly target: string
      readonly status: "active" | "inactive" | "failed"
      readonly error?: string
    }

export function PluginsDialog(props: {
  context: Plugin.Context
  plugins: ReturnType<typeof usePlugin>
  server?: () => readonly PluginInfo[]
}) {
  const dialog = useDialog()
  const i18n = useI18n()
  const [locked, setLocked] = createSignal(false)
  const [checking, setChecking] = createSignal(false)
  const [focused, setFocused] = createSignal<string>()
  const [detail, setDetail] = createSignal<Entry>()
  const [showInternal, setShowInternal] = createSignal(false)
  const [pending, setPending] = createSignal<readonly string[]>([])
  const [server, { refetch, mutate }] = createResource(
    () => (props.server ? undefined : (props.context.location ?? props.context.data.location.default())),
    (location) => props.context.client.plugin.list({ location }).then((result) => result.data),
  )
  onMount(() => dialog.setSize("large"))
  onCleanup(props.context.data.on("plugin.updated", () => void refetch()))
  const updating = (entry: Entry) =>
    pending().includes(entry.key) ||
    (entry.runtime === "server" && entry.plugin.source.type === "package" && entry.plugin.source.updating === true)
  const updatable = (entry: Entry | undefined) => entry !== undefined && outdated(entry) && !updating(entry)
  const entries = createMemo<Entry[]>(() => {
    const builtins: Entry[] = props.plugins
      .registered()
      .filter((plugin) => plugin.id !== id && plugin.source === "builtin")
      .map((plugin) => ({
        key: `tui:${plugin.id}`,
        runtime: "tui" as const,
        internal: true,
        id: plugin.id,
        target: plugin.id,
        status: plugin.active ? ("active" as const) : ("inactive" as const),
      }))
    const external: Entry[] = props.plugins
      .list()
      .filter((plugin) => plugin.status !== "unsupported")
      .map((plugin) => ({
        key: `tui:${plugin.id ?? plugin.target}`,
        runtime: "tui" as const,
        internal: false,
        id: plugin.id,
        target: plugin.target,
        status: plugin.status,
        error: plugin.status === "failed" ? plugin.error : undefined,
      }))
    const serverEntries: Entry[] = (props.server?.() ?? server() ?? []).map((plugin) => ({
      key: `server:${plugin.id ?? source(plugin, props.context)}`,
      runtime: "server" as const,
      internal: plugin.source.type === "builtin",
      plugin,
    }))
    return [
      ...[...builtins, ...external].sort((a, b) => label(a, props.context).localeCompare(label(b, props.context))),
      ...serverEntries.sort((a, b) => label(a, props.context).localeCompare(label(b, props.context))),
    ]
  })
  const visibleEntries = createMemo(() =>
    entries().filter((entry) => showInternal() || !entry.internal || status(entry) === "failed"),
  )
  createEffect(() => {
    if (visibleEntries().some((entry) => entry.key === focused())) return
    const first = visibleEntries().find((entry) => entry.runtime === "tui") ?? visibleEntries()[0]
    setFocused(first?.key)
  })
  const footer = (entry: Entry) => {
    const details = [
      ...(status(entry) === "active"
        ? []
        : [i18n.t(status(entry) === "inactive" ? "feature.plugins.status.inactive" : "feature.plugins.status.failed")]),
      ...(entry.runtime === "server" && entry.plugin.source.type === "package" && entry.plugin.source.version
        ? [i18n.t("feature.plugins.version", { version: displayVersion(entry.plugin.source.version) })]
        : []),
      ...(isLocal(entry) ? [i18n.t("feature.plugins.local")] : []),
      ...(outdated(entry) ? [i18n.t("feature.plugins.updateAvailable")] : []),
    ]
    return details.length ? details.join(", ") : undefined
  }

  const options = createMemo(() =>
    visibleEntries().map(
      (entry): DialogSelectOption<string> => ({
        title: label(entry, props.context),
        value: entry.key,
        category: i18n.t(entry.runtime === "tui" ? "feature.plugins.category.tui" : "feature.plugins.category.server"),
        searchText: entry.runtime === "tui" ? entry.target : source(entry.plugin, props.context),
        footer: updating(entry) ? i18n.t("feature.plugins.updating") : footer(entry),
        footerColor:
          status(entry) === "failed"
            ? props.context.theme.text.feedback.error.default
            : outdated(entry)
              ? props.context.theme.text.feedback.info.default
              : props.context.theme.text.subdued,
        gutter: updating(entry)
          ? (color) => <Spinner color={color} />
          : status(entry) === "active"
            ? () => <text fg={props.context.theme.text.feedback.success.default}>✓</text>
            : status(entry) === "failed"
              ? () => <text fg={props.context.theme.text.feedback.error.default}>✗</text>
              : undefined,
      }),
    ),
  )
  const focusedEntry = createMemo(() => entries().find((entry) => entry.key === focused()))
  const focusedTui = createMemo(() => {
    const entry = focusedEntry()
    if (entry?.runtime !== "tui" || !entry.id) return
    return entry
  })
  const toggleTitle = createMemo(() => {
    const entry = focusedTui()
    if (!entry) return i18n.t("feature.plugins.action.toggle")
    return props.plugins.registered().find((plugin) => plugin.id === entry.id)?.active
      ? i18n.t("feature.plugins.action.disable")
      : i18n.t("feature.plugins.action.enable")
  })
  const toggle = (entry: Entry | undefined) => {
    if (locked() || entry?.runtime !== "tui" || !entry.id) return
    const current = props.plugins.registered().find((plugin) => plugin.id === entry.id)
    if (!current) return
    setLocked(true)
    void (current.active ? props.plugins.deactivate(current.id) : props.plugins.activate(current.id))
      .then((ok) => {
        if (ok) return
        props.context.ui.toast.show({
          variant: "error",
          message: i18n.t("feature.plugins.updateFailed", { id: current.id }),
        })
      })
      .catch((cause) => {
        props.context.ui.toast.show({
          variant: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        })
      })
      .finally(() => setLocked(false))
  }
  const update = (entry: Entry | undefined) => {
    if (entry?.runtime !== "server" || entry.plugin.source.type !== "package" || !updatable(entry)) return
    const location = props.context.location ?? props.context.data.location.default()
    setPending((keys) => [...keys, entry.key])
    props.context.client.plugin
      .update({ location, targets: [entry.plugin.source.target] })
      .then(() => props.context.client.plugin.awaitActivation({ location }))
      .then(() => refetch())
      .catch((cause) => {
        props.context.ui.toast.show({
          variant: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        })
      })
      .finally(() => setPending((keys) => keys.filter((key) => key !== entry.key)))
  }
  const check = () => {
    if (checking()) return
    setChecking(true)
    props.context.client.plugin
      .check({ location: props.context.location ?? props.context.data.location.default() })
      .then((result) => mutate(result.data))
      .catch((cause) => {
        props.context.ui.toast.show({
          variant: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        })
      })
      .finally(() => setChecking(false))
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
            bindings={[
              {
                bind: "ctrl+a",
                title: i18n.t("feature.plugins.action.toggleInternal"),
                group: i18n.t("feature.plugins.group"),
                run: () => {
                  setShowInternal((value) => !value)
                },
              },
            ]}
            footerHints={[
              {
                title: "ctrl+a",
                label: i18n.t(
                  showInternal() ? "feature.plugins.hint.hideInternal" : "feature.plugins.hint.showInternal",
                ),
              },
            ]}
            onMove={(option) => setFocused(option.value)}
            onSelect={(option) => {
              const entry = entries().find((entry) => entry.key === option.value)
              if (
                entry?.runtime === "tui" &&
                entry.id &&
                props.plugins.registered().some((plugin) => plugin.id === entry.id)
              )
                return toggle(entry)
              if (pluginError(entry)) setDetail(entry)
            }}
            actions={[
              {
                title: i18n.t(
                  checking() ? "feature.plugins.action.checking" : "feature.plugins.action.checkForUpdates",
                ),
                command: "dialog.plugins.check",
                selection: "none",
                hidden: !entries().some(
                  (entry) => entry.runtime === "server" && entry.plugin.source.type === "package",
                ),
                disabled: checking(),
                onTrigger: check,
              },
              {
                title: toggleTitle(),
                command: "plugins.toggle",
                side: "right",
                hidden: !focusedTui(),
                onTrigger: (option) => toggle(entries().find((entry) => entry.key === option.value)),
              },
              {
                title: i18n.t("feature.plugins.action.update"),
                command: "dialog.plugins.update",
                side: "right",
                hidden: !updatable(focusedEntry()),
                onTrigger: (option) => update(entries().find((entry) => entry.key === option.value)),
              },
            ]}
            footer={
              <Show when={pluginError(focusedEntry())}>
                <text>
                  <span style={{ fg: props.context.theme.text.default }}>
                    <b>enter</b>
                  </span>
                  <span style={{ fg: props.context.theme.text.subdued }}> {i18n.t("feature.plugins.viewError")}</span>
                </text>
              </Show>
            }
          />
        }
      >
        {(entry) => (
          <DialogErrorDetails
            title={i18n.t("feature.plugins.errorDetails", { title: label(entry(), props.context) })}
            source={pluginSource(entry(), props.context)}
            error={pluginError(entry()) ?? i18n.t("feature.plugins.unknownError")}
            diagnosticRef={pluginErrorRef(entry())}
            context={`Plugin: ${label(entry(), props.context)}\nStatus: failed\nRuntime: ${entry().runtime}\nSource: ${pluginSource(entry(), props.context)}`}
            onBack={() => {
              setDetail()
              dialog.setSize("large")
            }}
          />
        )}
      </Show>
    </box>
  )
}

function label(entry: Entry, context: Plugin.Context) {
  if (entry.runtime === "tui") return entry.id ?? entry.target
  return entry.plugin.id ?? source(entry.plugin, context)
}

function pluginSource(entry: Entry, context: Plugin.Context) {
  if (entry.runtime === "tui") return entry.target
  return source(entry.plugin, context)
}

function source(plugin: PluginInfo, context: Plugin.Context) {
  if (plugin.source.type === "package") return plugin.source.target
  if (plugin.source.type === "local") return context.ui.format.path(plugin.source.path)
  return plugin.source.type
}

function isLocal(entry: Entry) {
  if (entry.runtime === "server") return entry.plugin.source.type === "local"
  return (
    entry.target.startsWith("file://") ||
    entry.target.startsWith("./") ||
    entry.target.startsWith("../") ||
    path.isAbsolute(entry.target)
  )
}

function outdated(entry: Entry) {
  return entry.runtime === "server" && entry.plugin.source.type === "package" && entry.plugin.source.outdated === true
}

function displayVersion(version: string) {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(version) ? version.slice(0, 7) : version
}

function status(entry: Entry) {
  if (entry.runtime === "server") return entry.plugin.status
  return entry.status
}

function pluginError(entry: Entry | undefined) {
  if (entry?.runtime === "server") return entry.plugin.status === "failed" ? entry.plugin.error : undefined
  return entry?.error
}

function pluginErrorRef(entry: Entry) {
  if (entry.runtime === "server" && entry.plugin.status === "failed") return entry.plugin.ref
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
          props.context.ui.dialog.show(() => <PluginsDialog context={props.context} plugins={plugins} />)
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
