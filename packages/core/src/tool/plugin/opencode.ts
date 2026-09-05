export * as OpenCodeTools from "./opencode.js"

import { ToolFailure } from "@opencode-ai/ai"
import type { Context } from "@opencode-ai/plugin/effect/plugin"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Session } from "@opencode-ai/schema/session"
import { Effect, Schema } from "effect"
import { PluginRuntime } from "../../plugin/runtime.js"

export const MoveInput = Schema.Struct({
  sessionID: Schema.optionalKey(Session.ID).annotate({
    description: "Omit to move the current session. A direct child owned by the current session is also allowed.",
  }),
  directory: AbsolutePath.check(Schema.isMinLength(1)).annotate({
    description: "Destination directory, relative to the target session's directory or absolute. Supports ~.",
  }),
})

export const MoveOutput = Schema.Struct({ sessionID: Session.ID, directory: AbsolutePath })

const sameLocation = (left: Session.Info["location"], right: Session.Info["location"]) =>
  left.directory === right.directory && left.workspaceID === right.workspaceID

export const move = Effect.fn("OpenCodeTools.move")(function* (
  sessions: Pick<PluginRuntime.Interface["session"], "get" | "move">,
  selected: Session.Info["location"],
  input: typeof MoveInput.Type,
  callerID: Session.ID,
) {
  const caller = yield* sessions.get(callerID).pipe(
    Effect.mapError((error) => new ToolFailure({ message: `Calling session not found: ${callerID}`, error })),
  )
  if (!sameLocation(caller.location, selected))
    return yield* new ToolFailure({
      message: `Calling session ${caller.id} does not belong to the selected instance`,
    })

  const target =
    input.sessionID === undefined || input.sessionID === caller.id
      ? caller
      : yield* sessions
          .get(input.sessionID)
          .pipe(
            Effect.mapError(
              (error) => new ToolFailure({ message: `Target session not found: ${input.sessionID}`, error }),
            ),
          )
  if (target.id !== caller.id && target.parentID !== caller.id)
    return yield* new ToolFailure({
      message: `Session ${target.id} is not a direct child owned by calling session ${caller.id}`,
    })
  if (!sameLocation(target.location, caller.location))
    return yield* new ToolFailure({
      message: `Session ${target.id} does not belong to the calling session's selected instance`,
    })

  yield* sessions.move({ sessionID: target.id, directory: input.directory, delivery: "steer" }).pipe(
    Effect.mapError((error) => new ToolFailure({ message: `Unable to move session to ${input.directory}`, error })),
  )
  return {
    output: { sessionID: target.id, directory: input.directory },
    content: `Move requested for session ${target.id} to ${input.directory}.`,
  }
})

export const Plugin = {
  id: "opencode.tools",
  effect: Effect.fn("OpenCodeTools.Plugin")(function* (ctx: Context) {
    const runtime = yield* PluginRuntime.Service
    yield* ctx.tool
      .transform((draft) => {
        draft.namespace({ name: "opencode", description: "OpenCode session and runtime tools." })
        draft.add({
          name: "session_move",
          description:
            "Move the current session or one of its direct child sessions to another directory. The session moves at the next safe boundary; do not run destination-dependent tools in the same execute call.",
          input: MoveInput,
          output: MoveOutput,
          options: { namespace: "opencode", codemode: true, pinned: true },
          execute: (input, context) => move(runtime.session, ctx.location, input, context.sessionID),
        })
      })
      .pipe(Effect.orDie)
  }),
}
