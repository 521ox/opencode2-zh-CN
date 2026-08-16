import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import path from "path"
import { Money } from "@opencode-ai/schema/money"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/util/effect/app-node"
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
import { SessionInbox } from "@opencode-ai/core/session/inbox"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { PluginRuntime } from "@opencode-ai/core/plugin/runtime"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { Permission } from "@opencode-ai/core/permission"
import { SubagentTool } from "@opencode-ai/core/tool/plugin/subagent"
import { Tool } from "@opencode-ai/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const childText = "child final response"
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("SubagentTest.complete")(function* (sessionID: Session.ID) {
        if (completed.has(sessionID)) return
        if ((yield* store.get(sessionID))?.title?.includes("fail")) {
          yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID })
          return
        }
        completed.add(sessionID)
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
          text: childText,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        owner: { id: "test-owner", pid: 0, hostname: "test", leaseMs: 30_000 },
        active: Effect.succeed(new Set()),
        claim: () => Effect.succeed(true),
        resume: complete,
        resumeClaimed: complete,
        wake: () => Effect.void,
        wakeActive: () => Effect.void,
        interrupt: () => Effect.void,
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const subagentPluginSupervisor = makeLocationNode({
  service: PluginSupervisor.Service,
  layer: Layer.effect(
    PluginSupervisor.Service,
    registerToolPlugin(SubagentTool.Plugin).pipe(Effect.as(PluginSupervisor.Service.of({ flush: Effect.void }))),
  ),
  deps: [Agent.node, Config.node, Permission.node, PluginRuntime.node, Tool.node],
})

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

const withSubagent = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* PluginSupervisor.Service.use((supervisor) => supervisor.flush).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((draft) => {
        // The caller identity used by executeTool; subagent permission asserts against it.
        draft.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        draft.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
          agent.model = childModel
        })
        draft.update(Agent.ID.make("fallback"), (agent) => {
          agent.mode = "subagent"
        })
        draft.update(Agent.ID.make("primary"), (agent) => {
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
          })
          expect((yield* sessions.get(childID)).parentID).toBe(parent.id)
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
          expect(settled.metadata).toEqual({ sessionID: child.id, status: "completed" })
          expect(progress[0]).toEqual({ sessionID: child.id, status: "running" })
          expect(child).toMatchObject({
            parentID: parent.id,
            location: parent.location,
            agent: "reviewer",
            model: childModel,
          })
          expect((yield* sessions.inbox(child.id)).find((message) => message.type === "user")?.payload.text).toBe(
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

  it.live("continues an existing direct child with the same agent", () =>
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
              input: { agent: "reviewer", description: "initial review", prompt: "review this" },
            },
          })
          const childID = outputSessionID(first.metadata)
          const continued = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-continue",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "continue review",
                prompt: "now inspect the tests",
                sessionID: childID,
              },
            },
          })

          expect(outputSessionID(continued.metadata)).toBe(childID)
          expect(continued.content).toEqual([{ type: "text", text: childText }])
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)
          expect((yield* sessions.inbox(childID)).filter((message) => message.type === "user").at(-1)?.payload.text).toBe(
            "now inspect the tests",
          )
        }),
      ),
    ),
  )

  it.live("rejects reuse across parents or agents", () =>
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
          yield* withSubagent(parent.location)
          const child = yield* sessions.create({ parentID: parent.id, agent: Agent.ID.make("reviewer") })
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const foreign = yield* executeTool(registry, {
            sessionID: otherParent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-foreign",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "foreign child",
                prompt: "continue",
                sessionID: child.id,
              },
            },
          })
          expect(foreign).toMatchObject({
            status: "error",
            error: { message: expect.stringContaining("is not a direct child") },
          })

          const wrongAgent = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-wrong-agent",
              name: SubagentTool.name,
              input: {
                agent: "fallback",
                description: "wrong agent",
                prompt: "continue",
                sessionID: child.id,
              },
            },
          })
          expect(wrongAgent).toMatchObject({
            status: "error",
            error: { message: expect.stringContaining("uses agent reviewer, not fallback") },
          })

          const missing = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-missing",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "missing child",
                prompt: "continue",
                sessionID: Session.ID.make("ses_missing_child"),
              },
            },
          })
          expect(missing).toMatchObject({
            status: "error",
            error: { message: expect.stringContaining("Subagent session not found") },
          })
        }),
      ),
    ),
  )

  it.live("adds context to a running direct child without creating another session", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const child = yield* sessions.create({ parentID: parent.id, agent: Agent.ID.make("reviewer") })
          const release = yield* Deferred.make<void>()
          yield* jobs.start({
            id: child.id,
            type: SubagentTool.name,
            title: "running child",
            run: Deferred.await(release).pipe(Effect.as("running child completed")),
          })
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
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
              id: "call-subagent-running-continue",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "extend running child",
                prompt: "also inspect the migration",
                sessionID: child.id,
              },
            },
          }).pipe(Effect.forkChild({ startImmediately: true }))

          const admission = Array.from(yield* Fiber.join(admitted))[0]
          expect(admission?.data.item.type).toBe("user")
          if (admission?.data.item.type !== "user") return yield* Effect.die("Expected user inbox item")
          expect(admission.data.item.payload.text).toBe("also inspect the migration")
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)
          yield* Deferred.succeed(release, undefined)

          const settled = yield* Fiber.join(executing)
          expect(outputSessionID(settled.metadata)).toBe(child.id)
          expect(settled.content).toEqual([{ type: "text", text: "running child completed" }])
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
              input: { agent: "reviewer", description: "background review", prompt: "review", background: true },
            },
          })
          const childID = outputSessionID(settled.metadata)
          expect(settled.metadata).toMatchObject({
            status: "running",
          })
          expect(settled.metadata).toEqual({ sessionID: childID, status: "running" })
          expect(settled.content).toEqual([
            {
              type: "text",
              text: [
                `The subagent is working in the background (id: ${childID}). You will be notified automatically when it finishes.`,
                "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
                "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
              ].join("\n"),
            },
          ])

          const admission = Array.from(yield* Fiber.join(admitted))[0]
          expect(admission?.data.item.type).toBe("synthetic")
          if (admission?.data.item.type !== "synthetic") return yield* Effect.die("Expected synthetic inbox item")
          expect(admission?.data.item.payload.text).toContain(`<subagent id="${childID}" state="completed"`)
          expect(admission?.data.item.payload).toMatchObject({
            description: "background review",
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
          expect(synthetic[0]?.text).toContain(`<subagent id="${childID}" state="completed"`)
          expect(synthetic[0]?.text).toContain(childText)
        }),
      ),
    ),
  )
})
