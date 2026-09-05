import { describe, expect } from "bun:test"
import path from "node:path"
import { LanguageModel, LLMEvent } from "@opencode-ai/ai"
import { OpenAIChat } from "@opencode-ai/ai/protocols/openai-chat"
import { TestLLM } from "@opencode-ai/ai/testing"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { EventTable } from "@opencode-ai/core/event/sql"
import { InstructionBuiltIns } from "@opencode-ai/core/instructions/builtins"
import { Instructions } from "@opencode-ai/core/instructions/index"
import { InstructionDiscovery } from "@opencode-ai/core/instruction-discovery"
import { Instance } from "@opencode-ai/core/instance/service"
import { Job } from "@opencode-ai/core/job"
import { KV } from "@opencode-ai/core/kv"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { Model } from "@opencode-ai/core/model"
import { McpInstructions } from "@opencode-ai/core/mcp/instructions"
import { Permission } from "@opencode-ai/core/permission"
import { PluginHooks } from "@opencode-ai/core/plugin/hooks"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { SystemPromptPlugin } from "@opencode-ai/core/plugin/system-prompt"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionContinuation } from "@opencode-ai/core/session/continuation"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRestart } from "@opencode-ai/core/session/execution/restart"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunnerLLM } from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionAssistantActiveTable, SessionAssistantPartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillInstructions } from "@opencode-ai/core/skill/instructions"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ReferenceInstructions } from "@opencode-ai/core/reference/instructions"
import { Event } from "@opencode-ai/schema/event"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { asc, eq, sql } from "drizzle-orm"
import { Context, Deferred, Effect, Exit, Layer, LayerMap, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { tmpdir } from "./fixture/tmpdir"
import { permissionLayer } from "./lib/permission"
import { it } from "./lib/effect"
import { agentHost, catalogHost, host } from "./plugin/host"

const sessionID = Session.ID.make("ses_restart_settlement")
const childSessionID = Session.ID.make("ses_restart_settlement_child")
const staleMessageID = SessionMessage.ID.make("msg_restart_settlement_stale")
const mismatchedSessionID = Session.ID.make("ses_restart_settlement_mismatch")
const mismatchedChildID = Session.ID.make("ses_restart_settlement_mismatch_child")
const mismatchedMessageID = SessionMessage.ID.make("msg_restart_settlement_mismatch")
const subagentInput = {
  prompt: "Inspect the interrupted work",
  description: "Inspect crash recovery",
  agent: "general",
}
const model = LanguageModel.make({ id: "restart-model", provider: "restart", route: OpenAIChat.route })
const eventModel = Model.Ref.make({ id: Model.ID.make("restart-model"), providerID: Provider.ID.make("restart") })
const resolved = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 1_000 },
      }),
    ),
})
const emptyBuiltIns = Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) })
const emptyDiscovery = Layer.mock(InstructionDiscovery.Service, {
  project: true,
  global: true,
  load: () => Effect.succeed(Instructions.empty),
})
const emptySkills = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const emptyReferences = Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const emptyMcp = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const quietPlugins = Layer.succeed(PluginSupervisor.Service, PluginSupervisor.Service.of({ awaitActivation: Effect.void }))
const emptyCatalog = Layer.mock(Catalog.Service, {
  provider: { get: () => Effect.undefined, all: () => Effect.succeed([]), available: () => Effect.succeed([]) },
  model: {
    get: () => Effect.undefined,
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    default: () => Effect.undefined,
    small: () => Effect.undefined,
  },
})

describe("Session restart stale-tool settlement", () => {
  it.effect(
    "recovers a validated foreground subagent identity before supersession and terminal claim release",
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const canned = TestLLM.layer({ fallback: [] })
      const base = AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          Bus.node,
          SessionProjector.node,
          SessionStore.node,
          Agent.node,
          Catalog.node,
          PluginHooks.node,
          Job.node,
          KV.node,
          SessionContinuation.node,
          Session.node,
        ]),
        [
          [Database.node, Database.configured({ path: path.join(tmp.path, "restart-settlement.sqlite") })],
          [Bus.node, Bus.configured({ persist: true })],
          [SessionExecution.node, SessionExecution.noopLayer],
          [Catalog.node, emptyCatalog],
          [Config.node, Config.testLayer()],
        ],
      ).pipe(Layer.provideMerge(canned))

      yield* seed.pipe(Effect.provide(Layer.fresh(base)))
      yield* verify.pipe(Effect.provide(Layer.fresh(base)))
    }),
    30_000,
  )
})

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(2_000)
  const db = (yield* Database.Service).db
  const bus = yield* Bus.Service
  const continuations = yield* SessionContinuation.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: "/project",
        title: "restart settlement",
        agent: "build",
        model: { id: "restart-model", providerID: "restart" },
        version: "test",
        time_suspended: 1,
        resume_attempts: 0,
        claim_owner: "dead-owner",
        claim_pid: 1,
        claim_hostname: "dead-host",
        claim_updated_at: 1,
        claim_expires_at: 1,
      },
      {
        id: childSessionID,
        parent_id: sessionID,
        project_id: Project.ID.global,
        slug: childSessionID,
        directory: "/project",
        title: "interrupted child",
        agent: "general",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* bus.publish(
    SessionEvent.Step.Started,
    {
      sessionID,
      assistantMessageID: staleMessageID,
      agent: Agent.ID.make("build"),
      model: eventModel,
    },
    { id: Event.ID.make("evt_restart_stale_step") },
  )
  yield* pending(bus, "stale-subagent", "subagent", subagentInput, true, 1)
  yield* pending(bus, "stale-generic", "echo", { text: "preserve durable input" }, false, 4)
  const identity = SessionContinuation.identity({
    parentSessionID: sessionID,
    parentMessageID: staleMessageID,
    parentToolCallID: "stale-subagent",
    prompt: subagentInput.prompt,
  })
  yield* continuations.admit({
    ...identity,
    childSessionID,
    parentSessionID: sessionID,
    parentMessageID: staleMessageID,
    parentToolCallID: "stale-subagent",
    agent: subagentInput.agent,
    description: subagentInput.description,
  })
})

const verify = Effect.gen(function* () {
  yield* TestClock.setTime(3_000)
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const store = yield* SessionStore.Service
  const agents = yield* Agent.Service
  const catalog = yield* Catalog.Service
  const hooks = yield* PluginHooks.Service
  const jobs = yield* Job.Service
  const continuations = yield* SessionContinuation.Service
  const sessions = yield* Session.Service
  const llm = yield* TestLLM.Service
  const db = database.db

  yield* agents.transform((draft) =>
    draft.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  const pluginHost = host({
    agent: agentHost(agents),
    catalog: catalogHost(catalog),
    session: { hook: (name, callback) => hooks.register("session", name, callback) },
  })
  yield* Effect.forEach(SystemPromptPlugin.Plugins, (plugin) => plugin.effect(pluginHost), { discard: true })

  expect(yield* store.pendingToolCalls(sessionID)).toMatchObject([
    {
      assistantMessageID: staleMessageID,
      tool: {
        id: "stale-subagent",
        name: "subagent",
        executed: true,
        providerState: { checkpoint: "stale-subagent" },
        state: { status: "running", input: subagentInput, metadata: {} },
      },
    },
    {
      assistantMessageID: staleMessageID,
      tool: {
        id: "stale-generic",
        name: "echo",
        executed: false,
        providerState: { checkpoint: "stale-generic" },
        state: { status: "running", input: { text: "preserve durable input" }, metadata: {} },
      },
    },
  ])

  const runner = AppNodeBuilder.build(SessionRunnerLLM.node, [
    [Database.node, Layer.succeed(Database.Service, database)],
    [Bus.node, Layer.succeed(Bus.Service, bus)],
    [SessionStore.node, Layer.succeed(SessionStore.Service, store)],
    [SessionContinuation.node, Layer.succeed(SessionContinuation.Service, continuations)],
    [Agent.node, Layer.succeed(Agent.Service, agents)],
    [Catalog.node, Layer.succeed(Catalog.Service, catalog)],
    [PluginHooks.node, Layer.succeed(PluginHooks.Service, hooks)],
    [LayerNodePlatform.llmClient, TestLLM.clientLayer],
    [SessionRunnerModel.node, resolved],
    [InstructionBuiltIns.node, emptyBuiltIns],
    [InstructionDiscovery.node, emptyDiscovery],
    [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
    [SkillInstructions.node, emptySkills],
    [ReferenceInstructions.node, emptyReferences],
    [McpInstructions.node, emptyMcp],
    [Config.node, Config.testLayer()],
    [Permission.node, permissionLayer()],
    [Snapshot.node, Snapshot.noopLayer],
    [PluginSupervisor.node, quietPlugins],
    [Catalog.node, emptyCatalog],
  ]).pipe(Layer.provide(Layer.succeed(TestLLM.Service, llm)))
  const locations = Layer.effect(
    LocationServiceMap.Service,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- execution resolves only the real runner from this explicit test Location graph
    LayerMap.make(() => runner as unknown as Layer.Layer<LocationServices>),
  )
  const instances = Layer.effect(
    Instance.Service,
    Effect.map(LocationServiceMap.Service, (locations) =>
      Instance.Service.of({
        provide: (session) => Effect.provide(locations.get(session.location).pipe(Layer.orDie)),
      }),
    ),
  )
  const execution = SessionExecution.layer.pipe(
    Layer.provide(Layer.succeed(SessionStore.Service, store)),
    Layer.provide(instances),
    Layer.provide(locations),
    Layer.provide(Layer.succeed(Bus.Service, bus)),
    Layer.provide(Layer.succeed(Database.Service, database)),
    Layer.provide(Layer.succeed(Job.Service, jobs)),
    Layer.provide(Layer.succeed(SessionContinuation.Service, continuations)),
  )
  const recovery = SessionRestart.layer().pipe(
    Layer.provideMerge(execution),
    Layer.provide(Layer.succeed(SessionStore.Service, store)),
    Layer.provide(Layer.succeed(Bus.Service, bus)),
    Layer.provide(Layer.succeed(Job.Service, jobs)),
    Layer.provide(Layer.succeed(Session.Service, sessions)),
    Layer.provide(Layer.succeed(SessionContinuation.Service, continuations)),
  )
  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(recovery, scope)
  const restart = Context.get(context, SessionRestart.Service)
  const executionService = Context.get(context, SessionExecution.Service)

  yield* db.run(sql`CREATE TEMP TABLE settlement_update_audit (message_id TEXT NOT NULL)`)
  yield* db.run(
    sql.raw(
      `CREATE TEMP TRIGGER settlement_message_update AFTER UPDATE ON session_message BEGIN INSERT INTO settlement_update_audit(message_id) VALUES (NEW.id); END`,
    ),
  )
  const terminal = yield* Deferred.make<SessionEvent.Event>()
  yield* bus
    .subscribe([SessionEvent.Execution.Succeeded, SessionEvent.Execution.Failed, SessionEvent.Execution.Interrupted])
    .pipe(
      Stream.runForEach((event) =>
        event.data.sessionID === sessionID ? Deferred.succeed(terminal, event).pipe(Effect.asVoid) : Effect.void,
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  yield* llm.push([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.stepFinish({ index: 0, reason: { normalized: "stop" } }),
    LLMEvent.finish({ reason: { normalized: "stop" } }),
  ])
  yield* restart.resumeSuspendedSessions
  const terminalEvent = yield* Deferred.await(terminal)
  yield* executionService.awaitIdle(sessionID)

  const events = yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  const failures = events.filter(
    (event) => event.type === "session.tool.failed.2" && event.data.assistantMessageID === staleMessageID,
  )
  const superseding = events.find(
    (event) => event.type === "session.step.started.1" && event.data.assistantMessageID !== staleMessageID,
  )
  const terminals = events.filter((event) =>
    ["session.execution.succeeded.1", "session.execution.failed.1", "session.execution.interrupted.1"].includes(
      event.type,
    ),
  )

  expect(terminalEvent).toMatchObject({ type: SessionEvent.Execution.Succeeded.type, data: { sessionID } })
  expect(terminals).toHaveLength(1)
  expect(terminals[0]).toMatchObject({ type: "session.execution.succeeded.1", data: { sessionID } })
  expect(failures).toHaveLength(2)
  expect(superseding).toBeDefined()
  expect(Math.max(...failures.map((event) => event.seq))).toBeLessThan(superseding!.seq)
  expect(failures.map((event) => event.data)).toMatchObject([
    {
      id: "stale-subagent",
      executed: true,
      metadata: { sessionID: childSessionID },
      error: { type: "aborted", message: expect.stringContaining(childSessionID) },
    },
    {
      id: "stale-generic",
      executed: false,
      error: { type: "aborted" },
    },
  ])
  expect(failures[1]?.data.metadata).toBeUndefined()

  const history = yield* store.context(sessionID)
  const stale = history.find((message) => message.id === staleMessageID)
  const encoded = stale ? Schema.encodeSync(SessionMessage.Info)(stale) : undefined
  expect(encoded).toMatchObject({
    type: "assistant",
    time: { completed: expect.any(Number) },
    content: [
      {
        id: "stale-subagent",
        executed: true,
        providerState: { checkpoint: "stale-subagent" },
        time: { created: 2_000, ran: 2_000, completed: 3_000 },
        state: {
          status: "error",
          input: subagentInput,
          metadata: { sessionID: childSessionID },
        },
      },
      {
        id: "stale-generic",
        executed: false,
        providerState: { checkpoint: "stale-generic" },
        time: { created: 2_000, ran: 2_000, completed: 3_000 },
        state: { status: "error", input: { text: "preserve durable input" } },
      },
    ],
  })
  expect(
    encoded &&
      encoded.type === "assistant" &&
      encoded.content[1]?.type === "tool" &&
      "metadata" in encoded.content[1].state,
  ).toBeFalse()
  expect(yield* store.pendingToolCalls(sessionID)).toEqual([])
  expect(yield* db.$count(SessionAssistantPartTable, eq(SessionAssistantPartTable.message_id, staleMessageID))).toBe(0)
  expect(
    yield* db.$count(SessionAssistantActiveTable, eq(SessionAssistantActiveTable.session_id, sessionID)),
  ).toBeLessThanOrEqual(1)
  expect(
    yield* db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM temp.settlement_update_audit WHERE message_id = ${staleMessageID}`,
    ),
  ).toEqual({ count: 1 })
  expect(
    yield* db
      .select({
        suspended: SessionTable.time_suspended,
        attempts: SessionTable.resume_attempts,
        owner: SessionTable.claim_owner,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie),
  ).toEqual({ suspended: null, attempts: 0, owner: null })

  const eventCount = events.length
  const requestCount = llm.requests.length
  yield* restart.resumeSuspendedSessions
  expect(yield* db.$count(EventTable, eq(EventTable.aggregate_id, sessionID))).toBe(eventCount)
  expect(llm.requests).toHaveLength(requestCount)

  const mismatchedInput = {
    prompt: "Do not recover this mismatched identity",
    description: "Mismatched continuation",
    agent: "general",
  }
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: mismatchedSessionID,
        project_id: Project.ID.global,
        slug: mismatchedSessionID,
        directory: "/project",
        title: "mismatched restart",
        agent: "build",
        model: { id: "restart-model", providerID: "restart" },
        version: "test",
        time_suspended: 1,
        resume_attempts: 0,
        claim_owner: "dead-mismatch-owner",
        claim_pid: 2,
        claim_hostname: "dead-host",
        claim_updated_at: 1,
        claim_expires_at: 1,
      },
      {
        id: mismatchedChildID,
        parent_id: mismatchedSessionID,
        project_id: Project.ID.global,
        slug: mismatchedChildID,
        directory: "/project",
        title: "mismatched child",
        agent: "general",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* bus.publish(
    SessionEvent.Step.Started,
    {
      sessionID: mismatchedSessionID,
      assistantMessageID: mismatchedMessageID,
      agent: Agent.ID.make("build"),
      model: eventModel,
    },
    { id: Event.ID.make("evt_restart_mismatch_step") },
  )
  yield* bus.publish(
    SessionEvent.Tool.Input.Started,
    {
      sessionID: mismatchedSessionID,
      assistantMessageID: mismatchedMessageID,
      id: "mismatched-subagent",
      name: "subagent",
    },
    { id: Event.ID.make("evt_restart_mismatch_1") },
  )
  yield* bus.publish(
    SessionEvent.Tool.Input.Ended,
    {
      sessionID: mismatchedSessionID,
      assistantMessageID: mismatchedMessageID,
      id: "mismatched-subagent",
      text: JSON.stringify(mismatchedInput),
    },
    { id: Event.ID.make("evt_restart_mismatch_2") },
  )
  yield* bus.publish(
    SessionEvent.Tool.Called,
    {
      sessionID: mismatchedSessionID,
      assistantMessageID: mismatchedMessageID,
      id: "mismatched-subagent",
      input: mismatchedInput,
      executed: true,
    },
    { id: Event.ID.make("evt_restart_mismatch_3") },
  )
  const mismatchedIdentity = SessionContinuation.identity({
    parentSessionID: mismatchedSessionID,
    parentMessageID: mismatchedMessageID,
    parentToolCallID: "mismatched-subagent",
    prompt: mismatchedInput.prompt,
  })
  yield* continuations.admit({
    ...mismatchedIdentity,
    promptDigest: SessionContinuation.identity({
      parentSessionID: mismatchedSessionID,
      parentMessageID: mismatchedMessageID,
      parentToolCallID: "mismatched-subagent",
      prompt: "different prompt",
    }).promptDigest,
    childSessionID: mismatchedChildID,
    parentSessionID: mismatchedSessionID,
    parentMessageID: mismatchedMessageID,
    parentToolCallID: "mismatched-subagent",
    agent: mismatchedInput.agent,
    description: mismatchedInput.description,
  })
  expect(yield* store.pendingToolCalls(mismatchedSessionID)).toMatchObject([
    {
      assistantMessageID: mismatchedMessageID,
      tool: {
        id: "mismatched-subagent",
        executed: true,
        state: { status: "running", input: mismatchedInput, metadata: {} },
      },
    },
  ])
  const mismatchedTerminal = yield* Deferred.make<SessionEvent.Event>()
  yield* bus
    .subscribe([SessionEvent.Execution.Succeeded, SessionEvent.Execution.Failed, SessionEvent.Execution.Interrupted])
    .pipe(
      Stream.runForEach((event) =>
        event.data.sessionID === mismatchedSessionID
          ? Deferred.succeed(mismatchedTerminal, event).pipe(Effect.asVoid)
          : Effect.void,
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  yield* llm.push([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.stepFinish({ index: 0, reason: { normalized: "stop" } }),
    LLMEvent.finish({ reason: { normalized: "stop" } }),
  ])
  yield* restart.resumeSuspendedSessions
  expect(yield* Deferred.await(mismatchedTerminal)).toMatchObject({
    type: SessionEvent.Execution.Succeeded.type,
    data: { sessionID: mismatchedSessionID },
  })
  yield* executionService.awaitIdle(mismatchedSessionID)
  const mismatchedEvents = yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, mismatchedSessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  const mismatchedFailure = mismatchedEvents.filter((event) => event.type === "session.tool.failed.2")
  expect(mismatchedFailure).toHaveLength(1)
  expect(mismatchedFailure[0]?.data).toMatchObject({
    assistantMessageID: mismatchedMessageID,
    id: "mismatched-subagent",
    executed: true,
    error: { type: "aborted", message: "Tool execution interrupted: subagent" },
  })
  expect(mismatchedFailure[0]?.data.metadata).toBeUndefined()
  expect(JSON.stringify(mismatchedFailure[0]?.data)).not.toContain(mismatchedChildID)
  const mismatchedHistory = yield* store.context(mismatchedSessionID)
  const mismatchedAssistant = mismatchedHistory.find((message) => message.id === mismatchedMessageID)
  const mismatchedEncoded = mismatchedAssistant
    ? Schema.encodeSync(SessionMessage.Info)(mismatchedAssistant)
    : undefined
  expect(mismatchedEncoded).toMatchObject({
    type: "assistant",
    content: [{ id: "mismatched-subagent", executed: true, state: { status: "error", input: mismatchedInput } }],
  })
  expect(
    mismatchedEncoded &&
      mismatchedEncoded.type === "assistant" &&
      mismatchedEncoded.content[0]?.type === "tool" &&
      "metadata" in mismatchedEncoded.content[0].state,
  ).toBeFalse()
  expect(
    yield* db
      .select({
        suspended: SessionTable.time_suspended,
        attempts: SessionTable.resume_attempts,
        owner: SessionTable.claim_owner,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, mismatchedSessionID))
      .get()
      .pipe(Effect.orDie),
  ).toEqual({ suspended: null, attempts: 0, owner: null })
  yield* Scope.close(scope, Exit.void)
})

function pending(
  bus: Bus.Interface,
  id: string,
  name: string,
  input: Record<string, unknown>,
  executed: boolean,
  event: number,
) {
  return Effect.gen(function* () {
    yield* bus.publish(
      SessionEvent.Tool.Input.Started,
      {
        sessionID,
        assistantMessageID: staleMessageID,
        id,
        name,
      },
      { id: Event.ID.make(`evt_restart_stale_${event}`) },
    )
    yield* bus.publish(
      SessionEvent.Tool.Input.Ended,
      {
        sessionID,
        assistantMessageID: staleMessageID,
        id,
        text: JSON.stringify(input),
      },
      { id: Event.ID.make(`evt_restart_stale_${event + 1}`) },
    )
    yield* bus.publish(
      SessionEvent.Tool.Called,
      {
        sessionID,
        assistantMessageID: staleMessageID,
        id,
        input,
        executed,
        state: { checkpoint: id },
      },
      { id: Event.ID.make(`evt_restart_stale_${event + 2}`) },
    )
  })
}
