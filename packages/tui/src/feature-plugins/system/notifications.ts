import { Plugin } from "@opencode-ai/plugin/tui"
import type { AttentionSoundName } from "@opencode-ai/plugin/tui/context"
import { createComponent, onCleanup } from "solid-js"
import { useI18n } from "../../context/i18n"
import type { Translator } from "../../i18n"

function notify(
  context: Plugin.Context,
  sessionID: string | undefined,
  message: string,
  sound: AttentionSoundName,
  title?: string,
) {
  const session = sessionID ? context.data.session.get(sessionID) : undefined
  const isSubagent = session?.parentID !== undefined
  void context.attention.notify({
    title: title ?? session?.title,
    message,
    notification: isSubagent ? false : { when: "blurred" },
    sound: { name: sound, when: "always" },
  })
}

export function subscribeNotifications(context: Plugin.Context, t: Translator) {
  const errored = new Set<string>()
  const terminal = new Set<string>()
  const forms = new Set<string>()
  const permissions = new Set<string>()

  const started = (sessionID: string) => {
    errored.delete(sessionID)
    terminal.delete(sessionID)
  }
  const ended = (sessionID: string) => {
    if (terminal.has(sessionID)) return
    terminal.add(sessionID)
    if (errored.has(sessionID)) {
      errored.delete(sessionID)
      return
    }
    const session = context.data.session.get(sessionID)
    notify(context, sessionID, t("feature.notifications.sessionDone"), session?.parentID ? "subagent_done" : "done")
  }

  const dispose = [
    context.data.on("form.created", (event) => {
      if (forms.has(event.data.form.id)) return
      forms.add(event.data.form.id)
      notify(
        context,
        event.data.form.sessionID,
        t("feature.notifications.formNeedsResponse"),
        "question",
        event.data.form.title,
      )
    }),
    context.data.on("form.replied", (event) => forms.delete(event.data.id)),
    context.data.on("form.cancelled", (event) => forms.delete(event.data.id)),
    context.data.on("permission.asked", (event) => {
      if (permissions.has(event.data.id)) return
      permissions.add(event.data.id)
      notify(context, event.data.sessionID, t("feature.notifications.permissionNeedsInput"), "permission")
    }),
    context.data.on("permission.replied", (event) => permissions.delete(event.data.requestID)),
    context.data.on("session.execution.started", (event) => started(event.data.sessionID)),
    context.data.on("session.execution.succeeded", (event) => ended(event.data.sessionID)),
    context.data.on("session.execution.interrupted", (event) => ended(event.data.sessionID)),
    context.data.on("session.execution.failed", (event) => {
      const sessionID = event.data.sessionID
      if (terminal.has(sessionID)) return
      if (errored.has(sessionID)) {
        ended(sessionID)
        return
      }
      errored.add(sessionID)
      notify(context, sessionID, event.data.error.message, "error")
      const route = context.ui.router.current()
      if (route.type === "session" && route.sessionID === sessionID)
        context.ui.toast.show({
          title: t("mini.transport.error.sessionExecutionFailed"),
          message: event.data.error.message,
          variant: "error",
        })
      ended(sessionID)
    }),
  ]

  return () => dispose.reverse().forEach((cleanup) => cleanup())
}

function Notifications(props: { context: Plugin.Context }) {
  const i18n = useI18n()
  onCleanup(subscribeNotifications(props.context, i18n.t))
  return null
}

export default Plugin.define({
  id: "opencode.notifications",
  setup(context) {
    context.ui.slot({ append: "app", render: () => createComponent(Notifications, { context }) })
  },
})
