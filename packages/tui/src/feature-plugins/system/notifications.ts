import type { Event } from "@opencode-ai/sdk/v2"
import type { TuiAttentionSoundName, TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"

const id = "internal:notifications"

type SessionError = Extract<Event, { type: "session.error" }>["properties"]["error"]

function notify(api: TuiPluginApi, sessionID: string | undefined, message: string, sound: TuiAttentionSoundName) {
  const session = sessionID ? api.state.session.get(sessionID) : undefined
  const isSubagent = session?.parentID !== undefined
  void api.attention.notify({
    title: session?.title,
    message,
    notification: isSubagent ? false : { when: "blurred" },
    sound: { name: sound, when: "always" },
  })
}

function sessionErrorMessage(error: SessionError) {
  if (error?.name === "MessageAbortedError") return "Session aborted"
  const data = error?.data
  if (data && typeof data === "object" && "message" in data && data.message === "SSE read timed out") {
    return "Model stopped responding"
  }
  return "Session error"
}

const tui: TuiPlugin = async (api) => {
  const active = new Set<string>()
  const errored = new Set<string>()
  const questions = new Set<string>()
  const permissions = new Set<string>()

  api.event.on("question.asked", (event) => {
    if (questions.has(event.properties.id)) return
    questions.add(event.properties.id)
    notify(api, event.properties.sessionID, "Question needs input", "question")
  })

  api.event.on("question.replied", (event) => {
    questions.delete(event.properties.requestID)
  })

  api.event.on("question.rejected", (event) => {
    questions.delete(event.properties.requestID)
  })

  api.event.on("permission.asked", (event) => {
    if (permissions.has(event.properties.id)) return
    permissions.add(event.properties.id)
    notify(api, event.properties.sessionID, "Permission needs input", "permission")
  })

  api.event.on("permission.replied", (event) => {
    permissions.delete(event.properties.requestID)
  })

  const started = (sessionID: string) => {
    active.add(sessionID)
    errored.delete(sessionID)
  }

  const ended = (sessionID: string) => {
    if (!active.has(sessionID)) return
    active.delete(sessionID)

    if (errored.has(sessionID)) {
      errored.delete(sessionID)
      return
    }

    const session = api.state.session.get(sessionID)
    notify(api, sessionID, "Session done", session?.parentID ? "subagent_done" : "done")
  }

  api.event.on("session.next.prompted", (event) => started(event.properties.sessionID))
  api.event.on("session.next.shell.started", (event) => started(event.properties.sessionID))
  api.event.on("session.next.step.started", (event) => started(event.properties.sessionID))
  api.event.on("session.next.retried", (event) => started(event.properties.sessionID))
  api.event.on("session.next.compaction.started", (event) => started(event.properties.sessionID))
  api.event.on("session.next.shell.ended", (event) => ended(event.properties.sessionID))
  api.event.on("session.next.step.ended", (event) => {
    if (event.properties.finish === "tool-calls") return
    ended(event.properties.sessionID)
  })
  api.event.on("session.next.step.failed", (event) => {
    const sessionID = event.properties.sessionID
    if (!active.has(sessionID)) return
    errored.add(sessionID)
    notify(api, sessionID, "Session error", "error")
    ended(sessionID)
  })

  api.event.on("session.error", (event) => {
    const sessionID = event.properties.sessionID
    if (!sessionID) return
    if (!active.has(sessionID)) return
    errored.add(sessionID)
    notify(api, sessionID, sessionErrorMessage(event.properties.error), "error")
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
