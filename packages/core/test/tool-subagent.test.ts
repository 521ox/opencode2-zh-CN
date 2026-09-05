import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import path from "path"
import { Money } from "@opencode-ai/schema/money"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { Bus } from "@opencode-ai/core/bus"
import { Config } from "@opencode-ai/core/config"
import { Location } from "@opencode-ai/core/location"
import { Model } from "@opencode-ai/core/model"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Agent } from "@opencode-ai/core/agent"
import { Job } from "@opencode-ai/core/job"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionContinuation } from "@opencode-ai/core/session/continuation"
import { SessionInbox } from "@opencode-ai/core/session/inbox"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import {
  SessionInboxTable,
  SessionSubagentContinuationTable,
  SessionSubagentTurnTable,
} from "@opencode-ai/core/session/sql"
import { PluginRuntime } from "@opencode-ai/core/plugin/runtime"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { Permission } from "@opencode-ai/core/permission"
import { SubagentTool } from "@opencode-ai/core/tool/plugin/subagent"
import { Tool } from "@opencode-ai/core/tool"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity, type ToolExecution } from "./lib/tool"

const childText = "child final response"
const emptyChildFallback = "Subagent completed without a text response."
const longChildText = Array.from(
  { length: ToolOutput.MAX_LINES + 101 },
  (_, index) => `${String(index).padStart(4, "0")}:${"x".repeat(32)}`,
).join("\n")
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
let waitFinal:
  | {
      sessionID: Session.ID
      started: Deferred.Deferred<void>
      release: Deferred.Deferred<void>
      text: string
    }
  | undefined

const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

const isNormalizedResult = (result: ToolExecution): result is ToolExecution & Tool.NormalizedResult =>
  result.status === "completed" && result.content !== undefined

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const database = yield* Database.Service
      const continuations = yield* SessionContinuation.Service
      const publish = Effect.fn("SubagentTest.publish")(function* (sessionID: Session.ID, text: string) {
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
        })
        yield* bus.publish(SessionEvent.Text.Started, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
        })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
        return assistantMessageID
      })
      const complete = Effect.fn("SubagentTest.complete")(function* (sessionID: Session.ID) {
        const session = yield* store.get(sessionID)
        const promoted = yield* SessionInbox.promoteDetailed(database.db, bus, sessionID, "input", {
          commit: (entry) => continuations.bind({ sessionID, inboxID: entry.id }),
        })
        if (promoted.length === 0) return
        if (session?.title?.includes("fail")) {
          const ids = yield* continuations.failActive({
            sessionID,
            error: { type: "model.not_selected", message: `No model is available for session ${sessionID}` },
          })
          yield* continuations.signal(ids)
          return
        }
        const pending = waitFinal
        if (pending?.sessionID === sessionID) {
          yield* Deferred.succeed(pending.started, undefined)
          yield* Deferred.await(pending.release)
        }
        const assistantMessageID = yield* publish(
          sessionID,
          pending?.sessionID === sessionID
            ? pending.text
            : session?.title?.includes("empty")
              ? ""
              : session?.title?.includes("large")
                ? longChildText
                : childText,
        )
        const turn = yield* continuations.active(sessionID)
        if (turn)
          yield* continuations.complete({
            sessionID,
            turnID: turn.id,
            assistantMessageID,
          })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        resume: complete,
        wake: (sessionID) => complete(sessionID).pipe(Effect.as({ type: "owned" as const })),
        interrupt: () => Effect.succeed(false),
        awaitIdle: () => Effect.void,
      })
    }),
  ),
  deps: [Bus.node, Database.node, SessionStore.node, SessionContinuation.node],
})

const subagentPluginSupervisor = makeLocationNode({
  service: PluginSupervisor.Service,
  layer: Layer.effect(
    PluginSupervisor.Service,
    registerToolPlugin(SubagentTool.Plugin).pipe(
      Effect.as(PluginSupervisor.Service.of({ awaitActivation: Effect.void })),
    ),
  ),
  deps: [Agent.node, Config.node, Permission.node, PluginRuntime.node, Tool.node],
})

const truncateWithStore = (result: Parameters<ToolOutput.Interface["truncate"]>[0]) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const layer = AppNodeBuilder.build(LayerNode.group([ToolOutput.node, FSUtil.node]), [
        [Global.node, Global.layerWith({ data: tmp.path })],
      ])
      return ToolOutput.Service.pipe(
        Effect.flatMap((output) => output.truncate(result)),
        Effect.provide(layer),
      )
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  PluginRuntime.providerNode,
  LocationServiceMap.node,
])
const replacements = [
  [SessionExecution.node, executionNode],
  [Global.node, tempGlobalLayer],
] satisfies LayerNode.Replacements
const productionIt = testEffect(AppNodeBuilder.build(nodes, replacements))
const it = testEffect(AppNodeBuilder.build(nodes, [...replacements, [PluginSupervisor.node, subagentPluginSupervisor]]))
const continuationRaceRuntime = PluginRuntime.makeCell()
const continuationRaceIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Job.node,
      Session.node,
      SessionContinuation.node,
      SessionExecution.node,
      PluginRuntime.providerNodeWithCell(continuationRaceRuntime),
      LocationServiceMap.node,
    ]),
    [
      ...replacements,
      [PluginRuntime.node, PluginRuntime.layerWithCell(continuationRaceRuntime)],
      [PluginSupervisor.node, subagentPluginSupervisor],
    ],
  ),
)

const withSubagent = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* PluginSupervisor.Service.use((supervisor) => supervisor.awaitActivation).pipe(
      Effect.provide(locations.get(location)),
    )
    yield* Agent.Service.use((agents) =>
      agents.transform((editor) => {
        // The caller identity used by executeTool; subagent permission asserts against it.
        editor.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
          agent.model = childModel
        })
        editor.update(Agent.ID.make("fallback"), (agent) => {
          agent.mode = "subagent"
        })
        editor.update(Agent.ID.make("primary"), (agent) => {
          agent.mode = "primary"
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

describe("SubagentTool", () => {
  productionIt.live("registers globally while resolving agents from the caller location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location })
          yield* withSubagent(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          expect((yield* registry.snapshot()).definitions.map((tool) => tool.name)).toContain(SubagentTool.name)
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-primary",
                name: SubagentTool.name,
                input: { agent: "primary", description: "primary", prompt: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: { type: "tool.execution", message: "Agent primary cannot run as a subagent" },
          })
        }),
      ),
    ),
  )

  it.live("prevents subagents from launching subagents by default", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent" })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-nested-subagent",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "nested", prompt: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: expect.stringContaining("Subagent depth limit reached (1)"),
            },
          })
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
        }),
      ),
    ),
  )

  it.live("allows nested subagents up to the configured depth", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(path.join(dir.path, "opencode.json"), JSON.stringify({ experimental: { subagent_depth: 2 } })),
          )
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent", model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-configured-nested-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "nested", prompt: "should run" },
            },
          })

          const childID = outputSessionID(settled.metadata)
          expect(settled).toMatchObject({
            status: "completed",
            metadata: { status: "completed" },
            content: [{ type: "text", text: childText }],
          })
          expect(settled.metadata).toEqual({
            sessionID: childID,
            status: "completed",
            truncated: false,
            subagentFinal: true,
          })
          expect((yield* sessions.get(childID)).parentID).toBe(parent.id)
        }),
      ),
    ),
  )

  it.live("does not let configured depth override the selected agent permission", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(path.join(dir.path, "opencode.json"), JSON.stringify({ experimental: { subagent_depth: 2 } })),
          )
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent", model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          yield* Agent.Service.use((agents) =>
            agents.transform((editor) => {
              editor.update(Agent.ID.make("reviewer"), (agent) => {
                agent.permissions.push({ action: SubagentTool.name, resource: "*", effect: "deny" })
              })
            }),
          ).pipe(Effect.provide(locations.get(parent.location)))
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              agent: Agent.ID.make("reviewer"),
              call: {
                type: "tool-call",
                id: "call-configured-nested-denied",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "nested", prompt: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: { type: "permission.rejected", message: "Permission denied: subagent" },
          })
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
        }),
      ),
    ),
  )

  it.live("runs a foreground child session and returns the final assistant text", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const progress: Tool.Metadata[] = []

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            progress: (update) => Effect.sync(() => progress.push(update)),
            call: {
              type: "tool-call",
              id: "call-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this" },
            },
          })

          const childID = outputSessionID(settled.metadata)
          expect(settled).toMatchObject({
            status: "completed",
            metadata: { status: "completed" },
            content: [{ type: "text", text: childText }],
          })
          const child = yield* sessions.get(childID)
          expect(settled.metadata).toEqual({
            sessionID: child.id,
            status: "completed",
            truncated: false,
            subagentFinal: true,
          })
          expect(progress[0]).toEqual({ sessionID: child.id, status: "running" })
          expect(child).toMatchObject({
            parentID: parent.id,
            location: parent.location,
            agent: "reviewer",
            model: childModel,
          })
          expect((yield* sessions.context(child.id)).find((message) => message.type === "user")?.text).toBe(
            "You are a subagent spawned by another session.\nreview this",
          )

          const fallback = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-fallback",
              name: SubagentTool.name,
              input: { agent: "fallback", description: "fallback", prompt: "fallback" },
            },
          })
          const fallbackChild = yield* sessions.get(outputSessionID(fallback.metadata))
          expect(fallbackChild).toMatchObject({ parentID: parent.id, model: parentModel })
        }),
      ),
    ),
  )

  it.live("keeps an empty canonical terminal private while returning the established foreground fallback", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-empty-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "empty foreground review", prompt: "return no text" },
            },
          })
          const childID = outputSessionID(settled.metadata)
          expect(settled.content).toEqual([{ type: "text", text: emptyChildFallback }])
          expect(settled.metadata).toEqual({
            sessionID: childID,
            status: "completed",
            truncated: false,
            subagentFinal: true,
          })
          const database = yield* Database.Service
          const turn = yield* database.db
            .select()
            .from(SessionSubagentTurnTable)
            .where(eq(SessionSubagentTurnTable.child_session_id, childID))
            .get()
            .pipe(Effect.orDie)
          expect(turn).toMatchObject({ state: "completed", output: "" })
        }),
      ),
    ),
  )

  it.live("returns a complete oversized foreground conclusion without ToolOutput preview truncation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          expect(Buffer.byteLength(longChildText, "utf8")).toBeGreaterThan(ToolOutput.MAX_BYTES)
          expect(longChildText.split("\n")).toHaveLength(ToolOutput.MAX_LINES + 101)
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-large-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "large conclusion", prompt: "return the conclusion" },
            },
          })
          if (!isNormalizedResult(settled)) return yield* Effect.die("Expected a normalized subagent result")
          const childID = outputSessionID(settled.metadata)
          const delivered = yield* truncateWithStore(settled)

          expect(delivered).toBe(settled)
          expect(settled.metadata).toEqual({
            sessionID: childID,
            status: "completed",
            truncated: false,
            subagentFinal: true,
          })
          expect(settled.content).toEqual([{ type: "text", text: longChildText }])
          expect(JSON.stringify(settled.content)).not.toContain("truncated; full content saved to")
          expect(settled.metadata).not.toHaveProperty("outputPath")
          const child = yield* sessions.context(childID)
          const assistant = child.findLast((message) => message.type === "assistant")
          expect(assistant?.type).toBe("assistant")
          if (assistant?.type !== "assistant") throw new Error("Expected child assistant message")
          expect(assistant.content).toContainEqual({ type: "text", text: longChildText })
        }),
      ),
    ),
  )

  it.live("continues an existing child session", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const first = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-first",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this" },
            },
          })
          const childID = outputSessionID(first.metadata)
          const second = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-second",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "follow up",
                prompt: "continue this",
                sessionID: childID,
              },
            },
          })

          expect(outputSessionID(second.metadata)).toBe(childID)
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)
          expect((yield* sessions.get(childID)).title).toBe("review")
          expect(
            (yield* sessions.context(childID)).flatMap((message) => (message.type === "user" ? [message.text] : [])),
          ).toEqual(["You are a subagent spawned by another session.\nreview this", "continue this"])
          expect(second.content).toEqual([{ type: "text", text: childText }])
          expect(second.metadata).toEqual({
            sessionID: childID,
            status: "completed",
            truncated: false,
            subagentFinal: true,
          })
        }),
      ),
    ),
  )

  continuationRaceIt.live("cancels the deterministic waiter when R terminalizes before foreground interruption", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const continuations = yield* SessionContinuation.Service
          const database = yield* Database.Service
          const bus = yield* Bus.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const child = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = {
            type: "tool-call" as const,
            id: "call-interrupt-before-wake",
            name: SubagentTool.name,
            input: { agent: "reviewer", description: "follow up", prompt: "interrupt me", sessionID: child.id },
          }
          const identity = SessionContinuation.identity({
            parentSessionID: parent.id,
            parentMessageID: toolIdentity.messageID,
            parentToolCallID: call.id,
            prompt: call.input.prompt,
          })
          const wakeStarted = yield* Deferred.make<void>()
          const releaseWake = yield* Deferred.make<void>()
          const runtime = continuationRaceRuntime.runtime
          if (!runtime) return yield* Effect.die("Foreground interruption runtime unavailable")
          let waiterStarts = 0
          continuationRaceRuntime.runtime = {
            ...runtime,
            session: {
              ...runtime.session,
              wake: (sessionID) =>
                sessionID === child.id
                  ? Deferred.succeed(wakeStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseWake)),
                      Effect.andThen(runtime.session.wake(sessionID)),
                    )
                  : runtime.session.wake(sessionID),
            },
            job: {
              ...runtime.job,
              guardedStart: (input) => {
                if (input.id === identity.waiterID) waiterStarts++
                return runtime.job.guardedStart(input)
              },
            },
          }

          yield* Effect.gen(function* () {
            const executing = yield* executeTool(registry, { sessionID: parent.id, ...toolIdentity, call }).pipe(
              Effect.forkChild({ startImmediately: true }),
            )
            yield* Deferred.await(wakeStarted)
            expect(yield* jobs.get(identity.waiterID)).toMatchObject({ status: "running" })

            expect(
              (yield* SessionInbox.promoteDetailed(database.db, bus, child.id, "input", {
                commit: (entry) => continuations.bind({ sessionID: child.id, inboxID: entry.id }),
              })).map((entry) => entry.id),
            ).toEqual([identity.inboxID])
            const assistantMessageID = SessionMessage.ID.create()
            const terminalText = "child terminal before foreground interruption"
            yield* bus.publish(SessionEvent.Step.Started, {
              sessionID: child.id,
              assistantMessageID,
              agent: Agent.ID.make("reviewer"),
              model: childModel,
            })
            yield* bus.publish(SessionEvent.Text.Started, { sessionID: child.id, assistantMessageID, ordinal: 0 })
            yield* bus.publish(SessionEvent.Text.Ended, {
              sessionID: child.id,
              assistantMessageID,
              ordinal: 0,
              text: terminalText,
            })
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: child.id,
              assistantMessageID,
              finish: "stop",
              cost: Money.USD.zero,
              tokens,
            })
            const turn = yield* continuations.active(child.id)
            if (!turn) return yield* Effect.die("Expected bound continuation turn")
            expect(yield* continuations.complete({ sessionID: child.id, turnID: turn.id, assistantMessageID })).toEqual(
              [identity.id],
            )
            expect(yield* continuations.get(identity.id)).toMatchObject({
              state: "completed",
              turn: { output: terminalText },
            })

            yield* Fiber.interrupt(executing)
            expect(yield* continuations.get(identity.id)).toMatchObject({ state: "completed" })
            expect(yield* sessions.inbox(child.id)).toEqual([])
            expect(yield* jobs.get(identity.waiterID)).toMatchObject({ status: "cancelled" })
            expect((yield* jobs.get(identity.waiterID))?.status).not.toBe("running")

            const retried = yield* executeTool(registry, { sessionID: parent.id, ...toolIdentity, call })
            expect(retried).toMatchObject({ status: "completed", content: [{ type: "text", text: terminalText }] })
            expect(waiterStarts).toBe(1)
            expect(yield* sessions.inbox(child.id)).toEqual([])
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(releaseWake, undefined).pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.sync(() => {
                    continuationRaceRuntime.runtime = runtime
                  }),
                ),
              ),
            ),
          )
        }),
      ),
    ),
  )

  continuationRaceIt.live("does not grant an interrupted conflicting replay cancellation authority", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const continuations = yield* SessionContinuation.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const child = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const legitimate = {
            type: "tool-call" as const,
            id: "call-replay-isolation",
            name: SubagentTool.name,
            input: {
              agent: "reviewer",
              description: "legitimate review",
              prompt: "legitimate prompt",
              sessionID: child.id,
            },
          }
          const identity = SessionContinuation.identity({
            parentSessionID: parent.id,
            parentMessageID: toolIdentity.messageID,
            parentToolCallID: legitimate.id,
            prompt: legitimate.input.prompt,
          })
          const peer: SessionContinuation.Request = {
            ...SessionContinuation.identity({
              parentSessionID: parent.id,
              parentMessageID: toolIdentity.messageID,
              parentToolCallID: "call-replay-isolation-peer",
              prompt: "peer prompt",
            }),
            parentSessionID: parent.id,
            parentMessageID: toolIdentity.messageID,
            parentToolCallID: "call-replay-isolation-peer",
            childSessionID: child.id,
            agent: "reviewer",
            description: "bound peer",
          }
          const conflicting = {
            ...legitimate,
            input: {
              ...legitimate.input,
              description: "conflicting review",
              prompt: "conflicting prompt",
            },
          }
          const legitimateStarted = yield* Deferred.make<void>()
          const conflictBeforeAdmission = yield* Deferred.make<void>()
          const releaseConflict = yield* Deferred.make<void>()
          const runtime = continuationRaceRuntime.runtime
          if (!runtime) return yield* Effect.die("Replay isolation runtime unavailable")
          let childPrompts = 0
          let childInterrupts = 0
          continuationRaceRuntime.runtime = {
            ...runtime,
            session: {
              ...runtime.session,
              wake: (sessionID) =>
                sessionID === child.id ? Effect.succeed({ type: "owned" as const }) : runtime.session.wake(sessionID),
              prompt: (input) =>
                Effect.gen(function* () {
                  if (input.sessionID === child.id) {
                    childPrompts++
                    if (childPrompts === 2) {
                      yield* Deferred.succeed(conflictBeforeAdmission, undefined)
                      yield* Deferred.await(releaseConflict)
                    }
                  }
                  return yield* runtime.session.prompt(input)
                }),
              interrupt: (sessionID, options) =>
                Effect.sync(() => {
                  if (sessionID === child.id) childInterrupts++
                }).pipe(Effect.andThen(runtime.session.interrupt(sessionID, options))),
            },
            job: {
              ...runtime.job,
              guardedStart: (input) =>
                runtime.job
                  .guardedStart(input)
                  .pipe(
                    Effect.tap((result) =>
                      input.id === identity.waiterID && result.type === "started"
                        ? Deferred.succeed(legitimateStarted, undefined).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  ),
            },
          }

          yield* Effect.gen(function* () {
            const legitimateRunning = yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: legitimate,
            }).pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(legitimateStarted)
            expect(yield* continuations.get(identity.id)).toMatchObject({ state: "admitted" })
            expect(yield* jobs.get(identity.waiterID)).toMatchObject({ status: "running" })

            yield* continuations.admit(peer)
            yield* continuations.bind({ sessionID: child.id, inboxID: identity.inboxID })
            yield* continuations.bind({ sessionID: child.id, inboxID: peer.inboxID })
            const legitimateBound = yield* continuations.get(identity.id)
            const peerBound = yield* continuations.get(peer.id)
            expect(legitimateBound).toMatchObject({ state: "bound" })
            expect(peerBound).toMatchObject({ state: "bound" })
            expect(legitimateBound?.turn?.id).toBe(peerBound?.turn?.id)

            const conflictingRunning = yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: conflicting,
            }).pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(conflictBeforeAdmission)
            yield* Fiber.interrupt(conflictingRunning)

            expect(yield* continuations.get(identity.id)).toMatchObject({ state: "bound" })
            expect(yield* continuations.get(peer.id)).toMatchObject({ state: "bound" })
            expect(yield* jobs.get(identity.waiterID)).toMatchObject({ status: "running" })
            expect(childInterrupts).toBe(0)

            const cancelled = yield* continuations.cancel(identity.id)
            yield* Effect.forEach([...new Set([...cancelled.waiterIDs, identity.waiterID])], jobs.cancel, {
              discard: true,
            })
            expect(yield* Fiber.join(legitimateRunning)).toMatchObject({ status: "error" })
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(releaseConflict, undefined).pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.sync(() => {
                    continuationRaceRuntime.runtime = runtime
                  }),
                ),
              ),
            ),
          )
        }),
      ),
    ),
  )

  continuationRaceIt.live("cancels a registered child waiter before Session deletion cascades its ledger", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const continuations = yield* SessionContinuation.Service
          const database = yield* Database.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const child = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = {
            type: "tool-call" as const,
            id: "call-delete-before-delivery",
            name: SubagentTool.name,
            input: {
              agent: "reviewer",
              description: "follow up",
              prompt: "delete before delivery",
              sessionID: child.id,
            },
          }
          const identity = SessionContinuation.identity({
            parentSessionID: parent.id,
            parentMessageID: toolIdentity.messageID,
            parentToolCallID: call.id,
            prompt: call.input.prompt,
          })
          const waiterRegistered = yield* Deferred.make<void>()
          const runtime = continuationRaceRuntime.runtime
          if (!runtime) return yield* Effect.die("Child deletion runtime unavailable")
          continuationRaceRuntime.runtime = {
            ...runtime,
            session: {
              ...runtime.session,
              // Return an owned wake without delivering the admitted Inbox item.
              wake: (sessionID) =>
                sessionID === child.id ? Effect.succeed({ type: "owned" as const }) : runtime.session.wake(sessionID),
            },
            continuation: {
              ...runtime.continuation,
              await: (id, options) =>
                id === identity.id
                  ? Deferred.succeed(waiterRegistered, undefined).pipe(
                      Effect.andThen(runtime.continuation.await(id, options)),
                    )
                  : runtime.continuation.await(id, options),
            },
          }

          yield* Effect.gen(function* () {
            const executing = yield* executeTool(registry, { sessionID: parent.id, ...toolIdentity, call }).pipe(
              Effect.forkChild({ startImmediately: true }),
            )
            yield* Deferred.await(waiterRegistered)
            yield* Effect.yieldNow
            expect(yield* continuations.get(identity.id)).toMatchObject({ state: "admitted" })
            expect((yield* sessions.inbox(child.id)).map((entry) => entry.id)).toEqual([identity.inboxID])
            expect(yield* jobs.get(identity.waiterID)).toMatchObject({ status: "running" })

            yield* sessions.remove(child.id)
            expect(yield* Fiber.join(executing)).toMatchObject({
              status: "error",
              error: { message: `Subagent cancelled (sessionID: ${child.id})` },
            })
            expect(yield* continuations.get(identity.id)).toBeUndefined()
            expect((yield* jobs.get(identity.waiterID))?.status).not.toBe("running")
            expect(
              yield* database.db
                .select()
                .from(SessionSubagentContinuationTable)
                .where(eq(SessionSubagentContinuationTable.child_session_id, child.id))
                .all()
                .pipe(Effect.orDie),
            ).toEqual([])
            expect(
              yield* database.db
                .select()
                .from(SessionSubagentTurnTable)
                .where(eq(SessionSubagentTurnTable.child_session_id, child.id))
                .all()
                .pipe(Effect.orDie),
            ).toEqual([])
            expect(
              yield* database.db
                .select()
                .from(SessionInboxTable)
                .where(eq(SessionInboxTable.session_id, child.id))
                .all()
                .pipe(Effect.orDie),
            ).toEqual([])
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                continuationRaceRuntime.runtime = runtime
              }),
            ),
          )
        }),
      ),
    ),
  )

  continuationRaceIt.live(
    "replays one deterministic continuation and rejects changed input before a waiter starts",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({ location, model: parentModel })
            yield* withSubagent(parent.location)
            const locations = yield* LocationServiceMap.Service
            const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
            const call = {
              type: "tool-call" as const,
              id: "call-deterministic-continuation",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "deterministic review", prompt: "review once" },
            }
            const first = yield* executeTool(registry, { sessionID: parent.id, ...toolIdentity, call })
            const childID = outputSessionID(first.metadata)
            const identity = SessionContinuation.identity({
              parentSessionID: parent.id,
              parentMessageID: toolIdentity.messageID,
              parentToolCallID: call.id,
              prompt: call.input.prompt,
            })
            const runtime = continuationRaceRuntime.runtime
            if (!runtime) return yield* Effect.die("Continuation replay runtime unavailable")
            let waiterStarts = 0
            continuationRaceRuntime.runtime = {
              ...runtime,
              job: {
                ...runtime.job,
                guardedStart: (input) => {
                  if (input.id === identity.waiterID) waiterStarts++
                  return runtime.job.guardedStart(input)
                },
              },
            }

            yield* Effect.gen(function* () {
              const replayed = yield* executeTool(registry, { sessionID: parent.id, ...toolIdentity, call })
              expect(outputSessionID(replayed.metadata)).toBe(childID)
              expect(replayed.content).toEqual([{ type: "text", text: childText }])
              expect(waiterStarts).toBe(0)
              expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)
              expect(
                (yield* sessions.context(childID)).filter(
                  (message) => message.type === "user" && message.id === identity.inboxID,
                ),
              ).toHaveLength(1)
              const database = yield* Database.Service
              expect(
                yield* database.db
                  .select()
                  .from(SessionSubagentContinuationTable)
                  .where(eq(SessionSubagentContinuationTable.id, identity.id))
                  .all()
                  .pipe(Effect.orDie),
              ).toHaveLength(1)

              waiterStarts = 0
              const conflict = yield* executeTool(registry, {
                sessionID: parent.id,
                ...toolIdentity,
                call: {
                  ...call,
                  input: { ...call.input, prompt: "changed prompt" },
                },
              })
              expect(conflict).toEqual({
                status: "error",
                error: {
                  type: "unknown",
                  message: "Continuation identity was reused with different input",
                },
              })
              expect(waiterStarts).toBe(0)
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  continuationRaceRuntime.runtime = runtime
                }),
              ),
            )
          }),
        ),
      ),
  )

  it.live("keeps its waiter pending until the bound turn stores the post-prompt final", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const child = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          waitFinal = { sessionID: child.id, started, release, text: "post-continuation final" }

          yield* Effect.gen(function* () {
            yield* withSubagent(parent.location)
            const locations = yield* LocationServiceMap.Service
            const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
            const executing = yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-wait-for-continuation-final",
                name: SubagentTool.name,
                input: {
                  agent: "reviewer",
                  description: "follow up",
                  prompt: "continue after idle",
                  sessionID: child.id,
                },
              },
            }).pipe(Effect.forkChild({ startImmediately: true }))

            const observed = yield* Deferred.await(started).pipe(Effect.timeoutOption("1 second"))
            expect(observed._tag).toBe("Some")
            expect(executing.pollUnsafe()).toBeUndefined()

            yield* Deferred.succeed(release, undefined)
            const settled = yield* Fiber.join(executing)
            expect(settled.content).toEqual([{ type: "text", text: "post-continuation final" }])
            expect(settled.metadata).toEqual({
              sessionID: child.id,
              status: "completed",
              truncated: false,
              subagentFinal: true,
            })
            const assistant = (yield* sessions.context(child.id)).findLast((message) => message.type === "assistant")
            expect(assistant?.type).toBe("assistant")
            if (assistant?.type !== "assistant") return yield* Effect.die("Expected child assistant message")
            expect(assistant.content).toContainEqual({ type: "text", text: "post-continuation final" })
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(release, undefined).pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.sync(() => {
                    waitFinal = undefined
                  }),
                ),
              ),
            ),
          )
        }),
      ),
    ),
  )

  continuationRaceIt.live(
    "admits concurrent continuations before distinct waiters start and binds their shared turn",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({ location, model: parentModel })
            const child = yield* sessions.create({
              parentID: parent.id,
              title: "review",
              agent: Agent.ID.make("reviewer"),
              model: childModel,
            })
            yield* withSubagent(parent.location)
            const runtime = continuationRaceRuntime.runtime
            if (!runtime) return yield* Effect.die("Continuation race runtime unavailable")
            const startBarrier = yield* Deferred.make<void>()
            const bothStartAttempts = yield* Deferred.make<void>()
            const bothDoorbells = yield* Deferred.make<void>()
            const bothRawStarts = yield* Deferred.make<void>()
            const starts: Array<{ id: string; startedAt: number }> = []
            let startAttempts = 0
            let doorbells = 0
            continuationRaceRuntime.runtime = {
              ...runtime,
              session: {
                ...runtime.session,
                wake: (sessionID) =>
                  Effect.gen(function* () {
                    if (sessionID === child.id) {
                      doorbells++
                      if (doorbells === 2) yield* Deferred.succeed(bothDoorbells, undefined)
                      yield* Deferred.await(bothDoorbells)
                    }
                    return yield* runtime.session.wake(sessionID)
                  }),
              },
              job: {
                ...runtime.job,
                guardedStart: (input) =>
                  Effect.gen(function* () {
                    startAttempts++
                    if (startAttempts === 2) yield* Deferred.succeed(bothStartAttempts, undefined)
                    yield* Deferred.await(startBarrier)
                    const result = yield* runtime.job.guardedStart(input)
                    if (result.type !== "started" && result.type !== "running")
                      return yield* Effect.die("Expected concurrent continuation to start a waiter")
                    starts.push({ id: result.info.id, startedAt: result.info.started_at })
                    if (starts.length === 2) yield* Deferred.succeed(bothRawStarts, undefined)
                    return result
                  }),
              },
            }

            yield* Effect.gen(function* () {
              const locations = yield* LocationServiceMap.Service
              const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
              const bus = yield* Bus.Service
              const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
                Stream.filter(
                  (event) =>
                    event.data.sessionID === child.id &&
                    event.data.item.type === "user" &&
                    ["first continuation", "second continuation"].includes(event.data.item.payload.text),
                ),
                Stream.take(2),
                Stream.runCollect,
                Effect.forkScoped({ startImmediately: true }),
              )
              const continuation = (id: string, prompt: string) =>
                executeTool(registry, {
                  sessionID: parent.id,
                  ...toolIdentity,
                  call: {
                    type: "tool-call",
                    id,
                    name: SubagentTool.name,
                    input: { agent: "reviewer", description: "follow up", prompt, sessionID: child.id },
                  },
                })

              const first = yield* continuation("call-first-continuation", "first continuation").pipe(
                Effect.forkChild({ startImmediately: true }),
              )
              yield* Effect.yieldNow
              const second = yield* continuation("call-second-continuation", "second continuation").pipe(
                Effect.forkChild({ startImmediately: true }),
              )

              yield* Deferred.await(bothStartAttempts)
              const durablePrompts = (yield* sessions.inbox(child.id)).flatMap((message) =>
                message.type === "user" ? [message.payload.text] : [],
              )
              expect(durablePrompts).toHaveLength(2)
              expect(durablePrompts).toEqual(expect.arrayContaining(["first continuation", "second continuation"]))
              expect(Array.from(yield* Fiber.join(admitted))).toHaveLength(2)
              expect(starts).toHaveLength(0)
              const database = yield* Database.Service
              const firstIdentity = SessionContinuation.identity({
                parentSessionID: parent.id,
                parentMessageID: toolIdentity.messageID,
                parentToolCallID: "call-first-continuation",
                prompt: "first continuation",
              })
              const secondIdentity = SessionContinuation.identity({
                parentSessionID: parent.id,
                parentMessageID: toolIdentity.messageID,
                parentToolCallID: "call-second-continuation",
                prompt: "second continuation",
              })
              const continuationRow = (id: string) =>
                database.db
                  .select()
                  .from(SessionSubagentContinuationTable)
                  .where(eq(SessionSubagentContinuationTable.id, id))
                  .get()
                  .pipe(Effect.orDie)
              expect((yield* continuationRow(firstIdentity.id))?.state).toBe("admitted")
              expect((yield* continuationRow(secondIdentity.id))?.state).toBe("admitted")

              yield* Deferred.succeed(startBarrier, undefined)
              yield* Deferred.await(bothRawStarts)
              expect(starts).toHaveLength(2)
              expect(new Set(starts.map((start) => start.id)).size).toBe(2)
              expect(starts.map((start) => start.id).toSorted()).toEqual(
                [firstIdentity.waiterID, secondIdentity.waiterID].toSorted(),
              )
              yield* Deferred.await(bothDoorbells)
              const firstResult = yield* Fiber.join(first)
              const secondResult = yield* Fiber.join(second)
              expect(outputSessionID(firstResult.metadata)).toBe(child.id)
              expect(outputSessionID(secondResult.metadata)).toBe(child.id)
              expect(firstResult.content).toEqual([{ type: "text", text: childText }])
              expect(secondResult.content).toEqual([{ type: "text", text: childText }])
              expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)
              const firstContinuation = yield* continuationRow(firstIdentity.id)
              const secondContinuation = yield* continuationRow(secondIdentity.id)
              expect(firstContinuation?.state).toBe("completed")
              expect(secondContinuation?.state).toBe("completed")
              expect(firstContinuation?.turn_id).toBe(secondContinuation?.turn_id)
              const turn = firstContinuation?.turn_id
                ? yield* database.db
                    .select()
                    .from(SessionSubagentTurnTable)
                    .where(eq(SessionSubagentTurnTable.id, firstContinuation.turn_id))
                    .get()
                    .pipe(Effect.orDie)
                : undefined
              expect(turn).toMatchObject({ state: "completed", output: childText })
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  continuationRaceRuntime.runtime = runtime
                }),
              ),
            )
          }),
        ),
      ),
  )

  it.live("does not let a running child Job satisfy a new continuation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const child = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          const release = yield* Deferred.make<void>()
          yield* jobs.start({
            id: child.id,
            type: SubagentTool.name,
            title: "running child",
            run: Deferred.await(release).pipe(Effect.as("running child completed")),
          })
          const bus = yield* Bus.Service
          const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
            Stream.filter((event) => event.data.sessionID === child.id && event.data.item.type === "user"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )

          const executing = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-running-subagent",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "follow up",
                prompt: "continue while running",
                sessionID: child.id,
              },
            },
          }).pipe(Effect.forkChild({ startImmediately: true }))

          const admission = Array.from(yield* Fiber.join(admitted))[0]
          expect(admission?.data.item.type).toBe("user")
          if (admission?.data.item.type !== "user") return yield* Effect.die("Expected user inbox item")
          expect(admission.data.item.payload.text).toBe("continue while running")
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)

          const settled = yield* Fiber.join(executing)
          expect(settled.content).toEqual([{ type: "text", text: childText }])
          expect(settled.metadata).toEqual({
            sessionID: child.id,
            status: "completed",
            truncated: false,
            subagentFinal: true,
          })
          expect(yield* jobs.get(child.id)).toMatchObject({ status: "running" })
          yield* Deferred.succeed(release, undefined)
        }),
      ),
    ),
  )

  it.live("rejects missing, foreign, and cross-agent continuation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const otherParent = yield* sessions.create({ location, model: parentModel })
          const unrelated = yield* sessions.create({
            parentID: otherParent.id,
            title: "other review",
            agent: Agent.ID.make("reviewer"),
          })
          const child = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
            model: parentModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (sessionID: Session.ID, id: string, agent = "reviewer") =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id,
                name: SubagentTool.name,
                input: { agent, description: "follow up", prompt: "continue", sessionID },
              },
            })

          const missing = Session.ID.create()
          expect(yield* call(missing, "call-missing-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Subagent session not found: ${missing}`,
            },
          })
          expect(yield* call(unrelated.id, "call-unrelated-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Subagent session ${unrelated.id} is not a direct child of ${parent.id}`,
            },
          })
          expect(yield* call(child.id, "call-cross-agent", "fallback")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Subagent session ${child.id} uses agent reviewer, not fallback`,
            },
          })
          expect(yield* sessions.get(child.id)).toMatchObject({
            agent: "reviewer",
          })
        }),
      ),
    ),
  )

  it.live("returns child runner failures as tool errors", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-subagent-failure",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "fail review", prompt: "please fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: expect.stringContaining("No model is available for session"),
            },
          })
        }),
      ),
    ),
  )

  continuationRaceIt.live(
    "does not create a second background waiter or notification for a terminal exact replay",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const sessions = yield* Session.Service
            const jobs = yield* Job.Service
            const bus = yield* Bus.Service
            const parent = yield* sessions.create({ location, model: parentModel })
            yield* withSubagent(parent.location)
            const locations = yield* LocationServiceMap.Service
            const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
            const call = {
              type: "tool-call" as const,
              id: "call-terminal-background-replay",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "terminal background review",
                prompt: "review once",
                background: true,
              },
            }
            const identity = SessionContinuation.identity({
              parentSessionID: parent.id,
              parentMessageID: toolIdentity.messageID,
              parentToolCallID: call.id,
              prompt: call.input.prompt,
            })
            const runtime = continuationRaceRuntime.runtime
            if (!runtime) return yield* Effect.die("Terminal replay runtime unavailable")
            let waiterStarts = 0
            const notifications: string[] = []
            yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
              Effect.sync(() => {
                if (event.data.sessionID === parent.id && event.data.item.type === "synthetic") {
                  notifications.push(event.data.inboxID)
                }
              }),
            )
            continuationRaceRuntime.runtime = {
              ...runtime,
              job: {
                ...runtime.job,
                guardedStart: (input) => {
                  if (input.id === identity.waiterID) waiterStarts++
                  return runtime.job.guardedStart(input)
                },
              },
            }

            yield* Effect.gen(function* () {
              const first = yield* executeTool(registry, { sessionID: parent.id, ...toolIdentity, call })
              const childID = outputSessionID(first.metadata)
              yield* Effect.yieldNow
              expect(first.metadata).toEqual({ sessionID: childID, status: "running" })
              expect(waiterStarts).toBe(1)
              expect(notifications).toHaveLength(1)
              expect(yield* jobs.pendingBackground).toEqual([])

              const replayed = yield* executeTool(registry, { sessionID: parent.id, ...toolIdentity, call })
              expect(replayed.metadata).toEqual({ sessionID: childID, status: "running" })
              expect(replayed.content).toEqual([
                { type: "text", text: expect.stringContaining(`sessionID: ${childID}`) },
              ])
              yield* Effect.yieldNow
              expect(waiterStarts).toBe(1)
              expect(notifications).toHaveLength(1)
              expect(yield* jobs.pendingBackground).toEqual([])
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  continuationRaceRuntime.runtime = runtime
                }),
              ),
            )
          }),
        ),
      ),
  )

  continuationRaceIt.live("skips a replay terminalized between its private read and guarded Job start", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const continuations = yield* SessionContinuation.Service
          const database = yield* Database.Service
          const bus = yield* Bus.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = {
            type: "tool-call" as const,
            id: "call-guarded-terminal-replay",
            name: SubagentTool.name,
            input: {
              agent: "reviewer",
              description: "guarded background review",
              prompt: "review once",
              background: true,
            },
          }
          const identity = SessionContinuation.identity({
            parentSessionID: parent.id,
            parentMessageID: toolIdentity.messageID,
            parentToolCallID: call.id,
            prompt: call.input.prompt,
          })
          const replayAtGuard = yield* Deferred.make<void>()
          const releaseReplay = yield* Deferred.make<void>()
          const parentNotified = yield* Deferred.make<void>()
          const runtime = continuationRaceRuntime.runtime
          if (!runtime) return yield* Effect.die("Guarded replay runtime unavailable")
          let guardCalls = 0
          let startedGenerations = 0
          let notifications = 0
          yield* bus.project(SessionEvent.InboxEnqueued, (event) => {
            if (event.data.sessionID !== parent.id || event.data.item.type !== "synthetic") return Effect.void
            return Deferred.succeed(parentNotified, undefined).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  notifications++
                }),
              ),
              Effect.asVoid,
            )
          })
          continuationRaceRuntime.runtime = {
            ...runtime,
            session: {
              ...runtime.session,
              // The first waiter owns an ordinary wake but delivery remains under this test's control.
              wake: (sessionID) =>
                sessionID === identity.childSessionID
                  ? Effect.succeed({ type: "owned" as const })
                  : runtime.session.wake(sessionID),
            },
            job: {
              ...runtime.job,
              guardedStart: (input) =>
                Effect.gen(function* () {
                  guardCalls++
                  if (guardCalls === 2) {
                    yield* Deferred.succeed(replayAtGuard, undefined)
                    yield* Deferred.await(releaseReplay)
                  }
                  const result = yield* runtime.job.guardedStart(input)
                  if (result.type === "started") startedGenerations++
                  return result
                }),
            },
          }

          yield* Effect.gen(function* () {
            const first = yield* executeTool(registry, { sessionID: parent.id, ...toolIdentity, call })
            const childID = outputSessionID(first.metadata)
            expect(first.metadata).toEqual({ sessionID: childID, status: "running" })
            expect(startedGenerations).toBe(1)
            expect(yield* jobs.get(identity.waiterID)).toMatchObject({ status: "running" })

            const replay = yield* executeTool(registry, { sessionID: parent.id, ...toolIdentity, call }).pipe(
              Effect.forkChild({ startImmediately: true }),
            )
            yield* Deferred.await(replayAtGuard)
            expect(guardCalls).toBe(2)

            expect(
              (yield* SessionInbox.promoteDetailed(database.db, bus, childID, "input", {
                commit: (entry) => continuations.bind({ sessionID: childID, inboxID: entry.id }),
              })).map((entry) => entry.id),
            ).toEqual([identity.inboxID])
            const assistantMessageID = SessionMessage.ID.create()
            const terminalText = "terminalized while replay waited for guarded start"
            yield* bus.publish(SessionEvent.Step.Started, {
              sessionID: childID,
              assistantMessageID,
              agent: Agent.ID.make("reviewer"),
              model: childModel,
            })
            yield* bus.publish(SessionEvent.Text.Started, { sessionID: childID, assistantMessageID, ordinal: 0 })
            yield* bus.publish(SessionEvent.Text.Ended, {
              sessionID: childID,
              assistantMessageID,
              ordinal: 0,
              text: terminalText,
            })
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: childID,
              assistantMessageID,
              finish: "stop",
              cost: Money.USD.zero,
              tokens,
            })
            const turn = yield* continuations.active(childID)
            if (!turn) return yield* Effect.die("Expected bound continuation turn")
            yield* continuations.complete({ sessionID: childID, turnID: turn.id, assistantMessageID })
            yield* Deferred.await(parentNotified)
            yield* Effect.yieldNow
            yield* jobs.wait({ id: identity.waiterID })
            expect(notifications).toBe(1)
            expect(yield* jobs.pendingBackground).toEqual([])

            yield* Deferred.succeed(releaseReplay, undefined)
            const replayed = yield* Fiber.join(replay)
            expect(replayed.metadata).toEqual({ sessionID: childID, status: "running" })
            expect(replayed.content).toEqual([{ type: "text", text: expect.stringContaining(`sessionID: ${childID}`) }])
            yield* Effect.yieldNow
            expect(startedGenerations).toBe(1)
            expect(notifications).toBe(1)
            expect(yield* jobs.pendingBackground).toEqual([])
          }).pipe(
            Effect.ensuring(
              Deferred.succeed(releaseReplay, undefined).pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.sync(() => {
                    continuationRaceRuntime.runtime = runtime
                  }),
                ),
              ),
            ),
          )
        }),
      ),
    ),
  )

  it.live("notifies once when background work completes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const bus = yield* Bus.Service
          const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id && event.data.item.type === "synthetic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-background-subagent",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "large background review",
                prompt: "review",
                background: true,
              },
            },
          })
          const childID = outputSessionID(settled.metadata)
          expect(settled.metadata).toMatchObject({
            status: "running",
          })
          expect(settled.metadata).toEqual({ sessionID: childID, status: "running" })
          expect(settled.metadata).not.toHaveProperty("subagentFinal")
          expect(settled.content).toEqual([{ type: "text", text: expect.stringContaining(`sessionID: ${childID}`) }])

          const admission = Array.from(yield* Fiber.join(admitted))[0]
          expect(admission?.data.item.type).toBe("synthetic")
          if (admission?.data.item.type !== "synthetic") return yield* Effect.die("Expected synthetic inbox item")
          expect(admission?.data.item.payload.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(admission?.data.item.payload).toMatchObject({
            description: "large background review",
            metadata: {
              source: "subagent",
              childID,
              agent: "reviewer",
              state: "completed",
            },
          })
          const database = yield* Database.Service
          yield* SessionInbox.promote(database.db, bus, parent.id, "steer")
          const synthetic = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(synthetic).toHaveLength(1)
          expect(synthetic[0]?.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(synthetic[0]?.text).toContain(longChildText)
          expect(Buffer.byteLength(synthetic[0]?.text ?? "", "utf8")).toBeGreaterThan(ToolOutput.MAX_BYTES)
          expect(synthetic[0]?.text).not.toContain("truncated; full content saved to")
        }),
      ),
    ),
  )

  it.live("uses the established fallback when an empty canonical terminal completes in the background", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const bus = yield* Bus.Service
          const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id && event.data.item.type === "synthetic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-empty-background-subagent",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "empty background review",
                prompt: "return no text",
                background: true,
              },
            },
          })
          const childID = outputSessionID(settled.metadata)
          const notification = Array.from(yield* Fiber.join(admitted))[0]
          expect(notification?.data.item.type).toBe("synthetic")
          if (notification?.data.item.type !== "synthetic") return yield* Effect.die("Expected synthetic inbox item")
          expect(notification.data.item.payload.text).toContain(emptyChildFallback)
          const database = yield* Database.Service
          const turn = yield* database.db
            .select()
            .from(SessionSubagentTurnTable)
            .where(eq(SessionSubagentTurnTable.child_session_id, childID))
            .get()
            .pipe(Effect.orDie)
          expect(turn).toMatchObject({ state: "completed", output: "" })
        }),
      ),
    ),
  )
})
