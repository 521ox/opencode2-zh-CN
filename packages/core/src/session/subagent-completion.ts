export * as SubagentCompletion from "./subagent-completion.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import type { Session } from "../session.js"
import type { SessionMessage } from "./message.js"

export const NO_TEXT = "Subagent completed without a text response."

export const visible = (output: string | undefined) =>
  output !== undefined && output.length > 0 ? output : NO_TEXT

export function text(message: SessionMessage.Info | undefined) {
  if (message?.type !== "assistant") return NO_TEXT
  return visible(
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  )
}

export const deliver = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "synthetic">,
  jobs: Pick<Job.Interface, "completeBackground">,
  input: Pick<Job.Info, "status" | "output" | "error" | "notificationID"> & {
    readonly recovery: Extract<Job.Recovery, { kind: "subagent" }>
    readonly resume?: boolean
  },
) {
  if (input.status === "running") return
  const text =
    input.status === "completed"
      ? visible(input.output)
      : input.status === "error"
        ? (input.error ?? "Subagent failed")
        : "Subagent cancelled"
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: input.recovery.parentSessionID,
    ...(input.resume === false ? { resume: false } : {}),
    description: input.recovery.description,
    text: `<subagent sessionID="${input.recovery.childSessionID}" state="${input.status}" description="${input.recovery.description}">\n${text}\n</subagent>`,
    metadata: {
      source: "subagent",
      childID: input.recovery.childSessionID,
      agent: input.recovery.agent,
      state: input.status,
    },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
