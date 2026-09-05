export * as SessionRunnerLLM from "./llm.js"

import { LLM, LLMClient, LLMRequest, Message, SystemPart } from "@opencode-ai/ai"
import { Cause, Config, Effect, Exit, FiberMap, Layer, Pull, Schedule } from "effect"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { InstructionState } from "../instruction-state.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContinuation } from "../continuation.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionHistory } from "../history.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionMessage } from "../message.js"
import { SessionRulesLocation } from "../rules-location.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { SessionTitle } from "../title.js"
import { DrainResult, Service, type Continuation } from "./index.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { llmClient } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import { SessionStep } from "./step.js"
import { ToolOutput } from "../../tool-output.js"
import { PluginSupervisor } from "../../plugin/supervisor.js"
import { PromptCacheDiagnostics } from "../prompt-cache-diagnostics.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const continuations = yield* SessionContinuation.Service
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* PluginSupervisor.Service
    const title = yield* SessionTitle.Service
    const steps = yield* SessionStep.make
    const diagnostics = yield* Config.boolean("OPENCODE_PROMPT_CACHE_DIAGNOSTICS").pipe(
      Config.withDefault(false),
      Effect.orDie,
    )
    const promptCacheSnapshots = diagnostics ? new Map<string, PromptCacheDiagnostics.Snapshot>() : undefined
    const diagnosePromptCache = Effect.fn("SessionRunner.diagnosePromptCache")(function* (
      sessionID: SessionSchema.ID,
      request: Parameters<typeof PromptCacheDiagnostics.snapshot>[0],
    ) {
      if (!promptCacheSnapshots) return
      const current = PromptCacheDiagnostics.snapshot(request)
      const comparison = PromptCacheDiagnostics.compare(promptCacheSnapshots.get(sessionID), current)
      promptCacheSnapshots.delete(sessionID)
      promptCacheSnapshots.set(sessionID, current)
      const oldest = promptCacheSnapshots.keys().next().value
      if (promptCacheSnapshots.size > 100 && oldest !== undefined) promptCacheSnapshots.delete(oldest)
      yield* Effect.logInfo("prompt cache prefix").pipe(
        Effect.annotateLogs({
          sessionID,
          toolCount: current.tools.length,
          systemParts: current.system.length,
          messageCount: current.messages.length,
          ...comparison,
        }),
      )
    })
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    const prepareRemoteRequest = Effect.fn("SessionRunner.prepareRemoteRequest")(function* (
      input: Parameters<SessionContext.Interface["prepare"]>[0],
    ) {
      return yield* context.prepare({ ...input, includeSessionRules: false })
    })

    /** Prepares the same post-hook conversation prefix as a Step, but never selects a WebSocket transport. */
    const prepareRemoteCompaction = Effect.fn("SessionRunner.prepareRemoteCompaction")(function* (
      sessionID: SessionSchema.ID,
      resolved: SessionContext.Loaded["model"],
    ) {
      const selected = yield* context.select(sessionID)
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      const loaded = yield* context.loadResolved(selected, resolved)
      const compactThreshold = compaction.remoteThreshold({ messages: loaded.messages, resolved: loaded.model })
      const transcript = SessionModelRequest.baseTranscript({
        agent: loaded.agent.info,
        model: loaded.model,
        tools: loaded.tools,
        initial: loaded.initial,
        messages: loaded.messages,
      })
      const prepared = yield* prepareRemoteRequest({
        scope: {
          session: loaded.session,
          agentID: loaded.agent.id,
          model: loaded.model,
          tools: loaded.tools,
          permissions: loaded.agent.info.permissions,
        },
        transcript,
        compactThreshold,
      })
      return { request: prepared.request, options: prepared.options }
    })

    const prepareStepRequest = Effect.fn("SessionRunner.prepareStepRequest")(function* (
      loaded: SessionContext.Loaded,
      step: number,
    ) {
      const stepLimitReached = loaded.agent.info.steps !== undefined && step >= loaded.agent.info.steps
      const compactThreshold = compaction.remoteThreshold({ messages: loaded.messages, resolved: loaded.model })
      const transcript = SessionModelRequest.baseTranscript({
        agent: loaded.agent.info,
        model: loaded.model,
        tools: loaded.tools,
        initial: loaded.initial,
        messages: loaded.messages,
      })
      const stepTranscript = {
        system: transcript.system,
        messages: stepLimitReached ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)] : transcript.messages,
      }
      const rules = yield* SessionRulesLocation.resolve({
        currentSessionID: loaded.session.id,
        currentSession: yield* store.rulesParent(loaded.session.id),
        getSession: store.rulesParent,
      })
      const prepared = yield* context.prepare({
        scope: {
          session: loaded.session,
          agentID: loaded.agent.id,
          model: loaded.model,
          tools: loaded.tools,
          permissions: loaded.agent.info.permissions,
        },
        transcript: stepTranscript,
        // Keep tool definitions on the final Step to preserve the provider's cached prefix.
        toolChoice: stepLimitReached ? "none" : undefined,
        compactThreshold,
        protectedSystem: SystemPart.make(SessionRulesLocation.render(rules)),
        webSocket: "session",
      })
      return { compactThreshold, prepared, stepLimitReached, stepTranscript }
    })
    type PreparedStep = Effect.Success<ReturnType<typeof prepareStepRequest>>
    type AdvanceReady = {
      readonly _tag: "Ready"
      readonly context: SessionContext.Loaded
      readonly explicit: boolean
      readonly request: PreparedStep | undefined
    }

    const drain = Effect.fn("SessionRunner.drain")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
      readonly continuation?: Continuation
      readonly promotable?: SessionInbox.Promotable
    }) {
      const sessionID = input.sessionID
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      let entering = true
      const promotable = input.promotable ?? "input"
      if (!force && !continuing) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        if (!pending) return DrainResult.Complete()
        const control = pending.type === "compaction" || pending.type === "move"
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      yield* plugins.awaitActivation
      yield* settleStaleToolCalls(sessionID)

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() => {
        let resolved: SessionContext.Loaded["model"] | undefined
        let explicitlyCompacted = false
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction")
                    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: next.id })
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              if (pending?.type === "move")
                return DrainResult.Moved({ continuation: continuing ? { step } : undefined })
              if (pending?.type === "compaction") {
                const session = yield* store.get(sessionID)
                if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    return yield* compaction.compactManual({
                      session,
                      resolveContext: (session) =>
                        Effect.gen(function* () {
                          const selected = yield* context.select(session.id)
                          const model = yield* context.resolveModel(selected.session)
                          // Preview instruction updates without admitting them after the delivered compaction control.
                          const history = yield* SessionHistory.preview(db, session.id, selected.instructions)
                          return {
                            session: selected.session,
                            agent: selected.agent,
                            tools: selected.tools,
                            model,
                            initial: history.initial,
                            messages: history.messages,
                            instructionUpdate: history.instructionUpdate,
                          }
                        }),
                      prepare: context.prepare,
                      messages: yield* store.context(sessionID),
                      inputID: pending.id,
                      prepareRemote: (resolved) => prepareRemoteCompaction(sessionID, resolved),
                    })
                  }),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                if (compacted.value.status === "failed" && "remote" in compacted.value && compacted.value.remote)
                  return yield* new StepFailedError({ error: compacted.value.error })
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer")))
                return DrainResult.Complete()
              const advanced = yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  const model = resolved ?? (yield* context.resolveModel(selected.session))
                  resolved = model
                  const scope = entering && !continuing ? promotable : "steer"
                  const probe = LLM.request({ model: model.model, prompt: "" })
                  if (LLMClient.canCompact(probe)) {
                    const durable = yield* context.loadResolved(selected, model)
                    const preview = yield* SessionInbox.previewPromotable(db, sessionID, scope)
                    const messages = [
                      ...durable.messages,
                      ...preview.map((entry) => SessionInbox.toMessage(entry, entry.timeCreated)),
                    ]
                    const loaded = { ...durable, messages }
                    const request = yield* prepareStepRequest(loaded, step)
                    const compactionInput = {
                      context: loaded,
                      prepare: context.prepare,
                    }
                    if (
                      !explicitlyCompacted &&
                      compaction.required({
                        messages: loaded.messages,
                        resolved: loaded.model,
                        context: loaded,
                        request: request.prepared.request,
                      })
                    ) {
                      const pending = new Set<string>(preview.map((entry) => entry.id))
                      const split = request.prepared.request.messages.findIndex((message) =>
                        message.id === undefined ? false : pending.has(message.id),
                      )
                      if (preview.length > 0 && split < 0)
                        return yield* new StepFailedError({
                          error: { type: "compaction.failed", message: "Pending Inbox input was absent from xAI preflight" },
                        })
                      const remote = {
                        request: LLMRequest.update(request.prepared.request, {
                          messages: request.prepared.request.messages.slice(
                            0,
                            split < 0 ? request.prepared.request.messages.length : split,
                          ),
                        }),
                        options: request.prepared.options,
                      }
                      const compacted = yield* compaction.compact({ ...compactionInput, remote })
                      if (compacted.status !== "completed")
                        return yield* new StepFailedError({ error: compacted.error })
                      explicitlyCompacted = true
                      return { _tag: "Retry" } satisfies { readonly _tag: "Retry" }
                    }
                    const promoted = yield* SessionInbox.promotePreviewed(db, bus, sessionID, scope, preview, {
                      commit: (entry) => continuations.bind({ sessionID, inboxID: entry.id }),
                    })
                    if (promoted.status === "mismatch")
                      return { _tag: "Retry" } satisfies { readonly _tag: "Retry" }
                    if (
                      promoted.entries.length > 0 &&
                      !selected.session.parentID &&
                      SessionTitle.isUntitled(selected.session)
                    )
                      yield* FiberMap.run(titles, sessionID, title.generate(sessionID).pipe(Effect.ignore), {
                        onlyIfMissing: true,
                      })
                    if (promoted.entries.length > 0) step = 1
                    return {
                      _tag: "Ready",
                      context: yield* context.loadResolved(selected, model),
                      explicit: true,
                      request,
                    } satisfies AdvanceReady
                  }
                  const promoted = yield* SessionInbox.promoteDetailed(
                    db,
                    bus,
                    sessionID,
                    scope,
                    {
                      commit: (entry) => continuations.bind({ sessionID, inboxID: entry.id }),
                    },
                  )
                  if (promoted.length > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID).pipe(Effect.ignore), {
                      onlyIfMissing: true,
                    })
                  if (promoted.length > 0) step = 1
                  return {
                    _tag: "Ready",
                    context: yield* context.loadResolved(selected, model),
                    explicit: false,
                    request: undefined,
                  } satisfies AdvanceReady
                }),
              )
              if (advanced._tag === "Retry") continue
              return advanced
            }
          }),
        )
      })

      while (true) {
        const next = yield* advanceToStep()
        if (next._tag !== "Ready") return next
        const turn = yield* continuations.active(sessionID)
        const stepped = yield* runStep(next.context, step, next.explicit, next.request)
        if (turn && !stepped.needsContinuation)
          yield* continuations.complete({
            sessionID,
            turnID: turn.id,
            assistantMessageID: stepped.assistantMessageID,
          })
        continuing = stepped.needsContinuation
        step++
        force = false
        entering = false
      }
    })

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    const runStep = Effect.fn("SessionRunner.runStep")(function* (
      first: SessionContext.Loaded,
      step: number,
      explicit: boolean,
      firstRequest?: PreparedStep,
    ) {
      const sessionID = first.session.id
      let assistantMessageID = SessionMessage.ID.create()
      const retry = yield* Schedule.toStepWithSleep(SessionRunnerRetry.schedule(bus, sessionID))
      let initial: SessionContext.Loaded | undefined = first
      let initialRequest = firstRequest
      let recoverOverflow = true
      let recoverContinuation = true
      while (true) {
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const loaded = initial ?? (yield* prepareContext(sessionID).pipe(Effect.flatMap(context.load)))
        initial = undefined
        const compactionInput = {
          context: loaded,
          prepare: context.prepare,
        }
        if (
          !explicit &&
          compaction.required({ messages: loaded.messages, resolved: loaded.model, context: loaded })
        ) {
          const compacted = yield* compaction.compact(compactionInput)
          if (compacted.status !== "completed") return yield* new StepFailedError({ error: compacted.error })
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        const request = initialRequest ?? (yield* prepareStepRequest(loaded, step))
        initialRequest = undefined
        const { compactThreshold, prepared, stepLimitReached, stepTranscript } = request
        const existingRemoteCompactions = new Set(
          loaded.messages.flatMap((message) =>
            message.type === "compaction" && message.status === "completed" && (message.remote?.length ?? 0) > 0
              ? [message.id]
              : [],
          ),
        )
        yield* diagnosePromptCache(sessionID, prepared.request)
        const outcome = yield* steps.attempt({
          sessionID,
          assistantMessageID,
          agent: loaded.agent.id,
          model: loaded.model,
          prepared,
          toolsDisabled: stepLimitReached,
          recoverContinuation,
          recoverOverflow: Effect.suspend(() =>
            recoverOverflow && compactThreshold !== undefined
              ? prepareRemoteRequest({
                  scope: {
                    session: loaded.session,
                    agentID: loaded.agent.id,
                    model: loaded.model,
                    tools: loaded.tools,
                    permissions: loaded.agent.info.permissions,
                  },
                  transcript: stepTranscript,
                  toolChoice: stepLimitReached ? "none" : undefined,
                  compactThreshold,
                }).pipe(
                  Effect.flatMap((remote) =>
                    compaction
                      .compactFallback({
                        session: loaded.session,
                        remote: { request: remote.request, options: remote.options },
                      })
                      .pipe(Effect.map((result) => result.status === "completed")),
                  ),
                )
              : recoverOverflow && !explicit && compaction.enabled()
                ? compaction.compact(compactionInput).pipe(Effect.map((result) => result.status === "completed"))
                : Effect.succeed(false),
          ),
        })
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          Completed: Effect.fnUntraced(function* (outcome) {
            if (
              outcome.tokens !== undefined &&
              compactThreshold !== undefined &&
              SessionCompaction.remoteFallbackRequired({
                threshold: compactThreshold,
                tokens: outcome.tokens,
                checkpointed: false,
              }) &&
              !(
                outcome.checkpointed ||
                (yield* SessionHistory.remoteCompactionForStep(
                  db,
                  sessionID,
                  assistantMessageID,
                  existingRemoteCompactions,
                ))
              )
            ) {
              const remote = yield* prepareRemoteRequest({
                scope: {
                  session: loaded.session,
                  agentID: loaded.agent.id,
                  model: loaded.model,
                  tools: loaded.tools,
                  permissions: loaded.agent.info.permissions,
                },
                transcript: stepTranscript,
                toolChoice: stepLimitReached ? "none" : undefined,
                compactThreshold,
              })
              const compacted = yield* compaction.compactFallback({
                session: loaded.session,
                remote: { request: remote.request, options: remote.options },
              })
              if (compacted.status !== "completed") return yield* new StepFailedError({ error: compacted.error })
            }
            return outcome.needsContinuation
          }),
          Retry: (outcome) =>
            retry({ cause: outcome.cause, error: outcome.error, assistantMessageID }).pipe(
              Pull.catchDone(() =>
                bus
                  .publish(SessionEvent.Step.Failed, { sessionID, assistantMessageID, error: outcome.error })
                  .pipe(Effect.andThen(outcome.cause)),
              ),
              Effect.asVoid,
            ),
          Continue: Effect.fnUntraced(function* (outcome) {
            yield* retry({ cause: outcome.cause, error: outcome.error, assistantMessageID }).pipe(
              Pull.catchDone(() => outcome.cause),
            )
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            assistantMessageID = SessionMessage.ID.create()
          }),
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
          }),
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
          }),
        })
        if (completed !== undefined) return { needsContinuation: completed, assistantMessageID }
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const pending of yield* store.pendingToolCalls(sessionID)) {
        let metadata = pending.tool.state.status === "running" ? pending.tool.state.metadata : undefined
        if (
          pending.tool.name === "subagent" &&
          pending.tool.state.status === "running" &&
          typeof pending.tool.state.input.prompt === "string"
        ) {
          const identity = SessionContinuation.identity({
            parentSessionID: sessionID,
            parentMessageID: pending.assistantMessageID,
            parentToolCallID: pending.tool.id,
            prompt: pending.tool.state.input.prompt,
          })
          const continuation = yield* continuations.get(identity.id)
          const request = continuation?.request
          if (
            request?.parentSessionID === sessionID &&
            request.parentMessageID === pending.assistantMessageID &&
            request.parentToolCallID === pending.tool.id &&
            request.promptDigest === identity.promptDigest
          ) {
            metadata = { ...metadata, sessionID: request.childSessionID }
          }
        }
        const childID =
          pending.tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
        yield* bus.publish(SessionEvent.Tool.Failed, {
          sessionID,
          assistantMessageID: pending.assistantMessageID,
          id: pending.tool.id,
          error: {
            type: "aborted",
            message: `Tool execution interrupted: ${pending.tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
          },
          ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
          executed: pending.tool.executed === true,
        })
      }
    })

    return Service.of({ drain })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    llmClient,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionCompaction.node,
    PluginSupervisor.node,
    SessionTitle.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
    SessionContinuation.node,
  ],
})
