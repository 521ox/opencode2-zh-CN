export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode-ai/ai"
import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { Deferred, Effect, Schema, Scope } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import type { Job } from "../../job.js"
import { PluginRuntime } from "../../plugin/runtime.js"
import { Permission } from "../../permission.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SessionContinuation } from "../../session/continuation.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"

export const name = "subagent"

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  ].join("\n"),
})

export const Input = Schema.Struct({
  agent: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      "Continue an existing direct child session created by this parent. The child must use the same agent. Omit to create a new child session.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})
export const description = [
  "Spawns or continues an agent in a direct child session to work on the specified task.",
  "Omit sessionID to create a fresh child and include all relevant context in the prompt.",
  "Pass a sessionID returned by an earlier call to continue that same direct child with the same agent.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  "Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.",
  "Use background only for independent work that can run while you continue elsewhere.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: PluginContext) {
    const runtime = yield* PluginRuntime.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const scope = yield* Scope.Scope
    // One completion observer per durable continuation request.
    const notifications = new Set<string>()

    const notifyWhenDone = Effect.fn("SubagentTool.notifyWhenDone")(function* (
      recovery: Extract<Job.Recovery, { kind: "subagent" }>,
      waiterID: string,
    ) {
      const key = waiterID
      if (notifications.has(key)) return
      notifications.add(key)
      yield* Effect.gen(function* () {
        const info = (yield* runtime.job.wait({ id: waiterID })).info
        if (info) yield* SubagentCompletion.deliver(runtime.session, runtime.job, { ...info, recovery })
      }).pipe(
        Effect.ensuring(Effect.sync(() => notifications.delete(key))),
        Effect.forkIn(scope, { startImmediately: true }),
      )
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* runtime.session
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                  ),
                )
              let current = parent
              let depth = 0
              while (current.parentID) {
                depth++
                current = yield* runtime.session
                  .get(current.parentID)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
                    ),
                  )
              }
              const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
              if (depth >= limit)
                return yield* new ToolFailure({
                  message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
                })
              const agent = yield* agents.resolve(input.agent)
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              if (agent.mode === "primary")
                return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })
              yield* permission
                .assert({
                  action: name,
                  resources: [agent.id],
                  save: [agent.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.messageID,
                    id: context.id,
                  },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

              const identity = SessionContinuation.identity({
                parentSessionID: context.sessionID,
                parentMessageID: context.messageID,
                parentToolCallID: context.id,
                prompt: input.prompt,
              })
              const background = input.background === true
              let childID = input.sessionID ?? identity.childSessionID
              const request = (childSessionID: SessionSchema.ID): SessionContinuation.Request => ({
                ...identity,
                parentSessionID: context.sessionID,
                parentMessageID: context.messageID,
                parentToolCallID: context.id,
                childSessionID,
                agent: agent.id,
                description: input.description,
              })
              const cancelForeground = Effect.uninterruptible(
                Effect.gen(function* () {
                  if (!(yield* runtime.continuation.matches(request(childID)))) return
                  const cancelled = yield* runtime.continuation.cancel(identity.id).pipe(Effect.orDie)
                  yield* Effect.forEach([...new Set([...cancelled.waiterIDs, identity.waiterID])], runtime.job.cancel, {
                    discard: true,
                  })
                  if (cancelled.interrupt) yield* runtime.session.interrupt(childID)
                }),
              )
              const execute = Effect.gen(function* () {
                const existing =
                  input.sessionID === undefined
                    ? yield* runtime.session
                        .get(identity.childSessionID)
                        .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
                    : yield* runtime.session
                        .get(input.sessionID)
                        .pipe(
                          Effect.mapError(
                            (error) =>
                              new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                          ),
                        )
                if (existing !== undefined && existing.parentID !== context.sessionID)
                  return yield* new ToolFailure({
                    message: `Subagent session ${existing.id} is not a direct child of ${context.sessionID}`,
                  })
                if (existing !== undefined && existing.agent !== agent.id)
                  return yield* new ToolFailure({
                    message: `Subagent session ${existing.id} uses agent ${existing.agent ?? "unknown"}, not ${agent.id}`,
                  })

                // Model selection is policy/config/session state, not an LLM-facing tool argument.
                const model = agent.model ?? parent.model
                const prompt =
                  input.sessionID === undefined
                    ? ["You are a subagent spawned by another session.", input.prompt].join("\n")
                    : input.prompt
                const child =
                  existing ??
                  (yield* runtime.session
                    .create({
                      id: identity.childSessionID,
                      parentID: context.sessionID,
                      title: input.description,
                      agent: agent.id,
                      model,
                      initialPrompt: {
                        id: identity.inboxID,
                        text: prompt,
                        commit: () => runtime.continuation.admit(request(identity.childSessionID)).pipe(Effect.orDie),
                      },
                    })
                    .pipe(
                      Effect.mapError(
                        (error) =>
                          new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                      ),
                    ))
                childID = child.id
                if (child.parentID !== context.sessionID || child.agent !== agent.id)
                  return yield* new ToolFailure({
                    message: `Subagent session ${child.id} conflicts with this parent or agent`,
                  })

                const replay = yield* runtime.continuation.get(identity.id)
                if (replay?.state === "completed" || replay?.state === "failed" || replay?.state === "cancelled") {
                  // Validate the deterministic identity without recreating a cancelled or delivered Inbox item.
                  yield* runtime.continuation.admit(request(child.id)).pipe(Effect.orDie)
                  if (background) return backgroundResult(child.id)
                  if (replay.state === "completed")
                    return {
                      sessionID: child.id,
                      status: "completed" as const,
                      output: SubagentCompletion.visible(replay.turn?.output),
                    }
                  if (replay.state === "failed")
                    return yield* new ToolFailure({
                      message: `Subagent failed (sessionID: ${child.id}): ${replay.turn?.error?.message ?? "unknown error"}`,
                    })
                  return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child.id})` })
                }

                yield* context.progress({ sessionID: child.id, status: "running" })
                // Existing children admit before their waiter can join. New children carry this
                // same admission in Session.Created + InboxEnqueued's one durable transaction.
                if (existing !== undefined)
                  yield* runtime.session
                    .prompt({
                      id: identity.inboxID,
                      sessionID: child.id,
                      text: prompt,
                      resume: false,
                      commit: () => runtime.continuation.admit(request(child.id)).pipe(Effect.orDie),
                    })
                    .pipe(
                      Effect.mapError(
                        (error) =>
                          new ToolFailure({ message: `Unable to continue subagent session ${child.id}`, error }),
                      ),
                    )

                const wake = yield* Deferred.make<Session.WakeResult, ToolFailure>()
                const recovery: Extract<Job.Recovery, { kind: "subagent" }> = {
                  kind: "subagent",
                  parentSessionID: context.sessionID,
                  childSessionID: child.id,
                  agent: agent.name,
                  description: input.description,
                  continuationID: identity.id,
                }
                const started = yield* runtime.job.guardedStart({
                  id: identity.waiterID,
                  type: name,
                  title: input.description,
                  metadata: {},
                  recovery,
                  run: Deferred.await(wake).pipe(
                    Effect.flatMap((result) =>
                      runtime.continuation.await(
                        identity.id,
                        result.type === "foreign"
                          ? {
                              foreign: {
                                wake: runtime.session.wake(child.id).pipe(
                                  Effect.mapError(
                                    (error) =>
                                      new ToolFailure({
                                        message: `Unable to reconcile subagent session ${child.id}`,
                                        error,
                                      }),
                                  ),
                                  Effect.asVoid,
                                ),
                              },
                            }
                          : undefined,
                      ),
                    ),
                    Effect.catchTag("SessionContinuation.FailedError", (error) =>
                      Effect.fail(new Error(error.error.message)),
                    ),
                  ),
                  // This is the atomic terminal-or-start decision. It must not call Job again.
                  guard: runtime.continuation
                    .get(identity.id)
                    .pipe(
                      Effect.map(
                        (continuation) => continuation?.state === "admitted" || continuation?.state === "bound",
                      ),
                    ),
                })
                if (started.type === "existing-terminal" || started.type === "skipped-terminal") {
                  // A false guard observed an immutable terminal R while Job held its map lock.
                  const terminal = yield* runtime.continuation.get(identity.id)
                  if (
                    terminal?.state === "completed" ||
                    terminal?.state === "failed" ||
                    terminal?.state === "cancelled"
                  ) {
                    if (background) return backgroundResult(child.id)
                    if (terminal.state === "completed")
                      return {
                        sessionID: child.id,
                        status: "completed" as const,
                        output: SubagentCompletion.visible(terminal.turn?.output),
                      }
                    if (terminal.state === "failed")
                      return yield* new ToolFailure({
                        message: `Subagent failed (sessionID: ${child.id}): ${terminal.turn?.error?.message ?? "unknown error"}`,
                      })
                    return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child.id})` })
                  }
                  return yield* new ToolFailure({
                    message: `Subagent continuation is unavailable (sessionID: ${child.id})`,
                  })
                }
                const info = started.info

                if (background) {
                  yield* runtime.job.background(info.id)
                  yield* notifyWhenDone(recovery, info.id)
                }

                // Background ownership is durable before this ordinary non-forcing wake can start child work.
                yield* runtime.session.wake(child.id).pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Unable to wake subagent session ${child.id}`, error }),
                  ),
                  Effect.tap((result) => Deferred.succeed(wake, result).pipe(Effect.ignore)),
                  Effect.catch((error) => Deferred.fail(wake, error).pipe(Effect.andThen(Effect.fail(error)))),
                )

                if (background) return backgroundResult(child.id)

                const result = yield* runtime.job.block({ id: info.id, sessionID: context.sessionID })
                if (result?.type === "backgrounded") {
                  yield* notifyWhenDone(recovery, info.id)
                  return backgroundResult(child.id)
                }
                // Failure surfaces keep the sessionID visible so the model can continue the child.
                if (result?.info.status === "error")
                  return yield* new ToolFailure({
                    message: `Subagent failed (sessionID: ${child.id}): ${result.info.error ?? "unknown error"}`,
                  })
                if (result?.info.status === "cancelled")
                  return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child.id})` })
                return {
                  sessionID: child.id,
                  status: "completed" as const,
                  output: SubagentCompletion.visible(result?.info.output),
                }
              })
              return yield* background ? execute : execute.pipe(Effect.onInterrupt(() => cancelForeground))
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionContinuation.ConflictError
                  ? Effect.fail(
                      new ToolFailure({ message: `Subagent continuation conflict: ${defect.message}`, error: defect }),
                    )
                  : Effect.die(defect),
              ),
              Effect.map((output) => ({
                output,
                content: output.output,
                metadata: {
                  sessionID: output.sessionID,
                  status: output.status,
                  ...(output.status === "completed" ? { truncated: false, subagentFinal: true } : {}),
                },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        if (available.length === 0) return
        tool.description = [
          tool.description,
          "",
          "Available subagents:",
          ...available.map(
            (agent) =>
              `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
          ),
        ].join("\n")
      }),
    )
  }),
}
