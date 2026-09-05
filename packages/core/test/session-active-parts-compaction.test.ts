import { expect } from "bun:test"
import { LLMClient, LLMEvent, LanguageModel, type LLMRequest } from "@opencode-ai/ai"
import { OpenAIChat, OpenAIResponses } from "@opencode-ai/ai/protocols"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionModelRequest } from "@opencode-ai/core/session/model-request"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { PluginHooks } from "@opencode-ai/core/plugin/hooks"
import { Money } from "@opencode-ai/schema/money"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { DateTime, Effect, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const build = Agent.ID.make("build")
const modelRef = { id: "compaction-model", providerID: "test" }
const localModel = LanguageModel.make({ id: modelRef.id, provider: modelRef.providerID, route: OpenAIChat.route })
const local = SessionRunnerModel.resolved(localModel, {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 100_000, output: 10_000 },
})
const nativeModel = LanguageModel.make({ id: "gpt-5", provider: "openai", route: OpenAIResponses.route })
const native = SessionRunnerModel.resolved(nativeModel, {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 100_000, output: 10_000 },
})
const terminalTokens = { input: 80_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const requests: LLMRequest[] = []
const client = Layer.mock(LLMClient.Service)({
  stream: (request) => {
    requests.push(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "summary", text: "deterministic summary" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: { normalized: "stop" },
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          nonCachedInputTokens: 10,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          reasoningTokens: 0,
        },
      }),
      LLMEvent.finish({ reason: { normalized: "stop" } }),
    )
  },
  generate: () => Effect.die("unused"),
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      PluginHooks.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      Config.node,
    ]),
    [
      [Bus.node, Bus.configured({ persist: true })],
      [Config.node, Config.testLayer()],
      [llmClient, client],
    ],
  ),
)

it.effect("summarizes assembled active text and tool content without a provider", () =>
  Effect.gen(function* () {
    requests.length = 0
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    const modelRequests = yield* SessionModelRequest.Service
    const sessionID = Session.ID.make("ses_active_compaction_manual")
    const assistantMessageID = SessionMessage.ID.make("msg_active_compaction_manual")
    const session = yield* insertSession(db, store, sessionID)
    yield* activeToolTail(bus, sessionID, assistantMessageID)
    const messages = yield* store.context(sessionID)
    expect(messages).toMatchObject([
      {
        type: "assistant",
        content: [
          { type: "text", text: "assembled crash-residue text" },
          {
            type: "tool",
            id: "call_active_compaction",
            state: { status: "completed", content: [{ type: "text", text: "assembled tool result" }] },
          },
        ],
      },
    ])

    expect(
      yield* compaction.compactManual({
        session,
        messages,
        inputID: SessionMessage.ID.make("msg_active_compaction_request"),
        resolveModel: () => Effect.succeed(local),
        prepare: modelRequests.prepare,
      }),
    ).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.model).toBe(localModel)
    expect(requests[0]?.promptCacheKey).toBe(sessionID)
    const prompt = JSON.stringify(requests[0]?.messages)
    expect(prompt).toContain("assembled crash-residue text")
    expect(prompt).toContain("read")
    expect(prompt).toContain("README.md")
    expect(prompt).toContain("assembled tool result")
  }),
)

it.effect("reads auto and remote thresholds from an assembled reopened assistant", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    const sessionID = Session.ID.make("ses_active_compaction_threshold")
    const assistantMessageID = SessionMessage.ID.make("msg_active_compaction_threshold")
    yield* insertSession(db, store, sessionID)
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: build,
      model: local.ref,
    })
    yield* bus.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID,
      finish: "stop",
      cost: Money.USD.zero,
      tokens: terminalTokens,
    })
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: build,
      model: local.ref,
    })
    const messages = yield* store.context(sessionID)
    expect(messages).toMatchObject([{ type: "assistant", tokens: terminalTokens }])
    const reopened = messages[0]
    expect(reopened?.type === "assistant" ? reopened.time.completed : null).toBeUndefined()
    expect(compaction.required({ messages, resolved: local })).toBe(true)
    expect(compaction.remoteThreshold({ messages, resolved: native })).toBe(80_000)
    expect(compaction.required({ messages, resolved: native })).toBe(false)
  }),
)

it.effect("attaches an active previous assistant at a remote checkpoint without changing request routing", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const modelRequests = yield* SessionModelRequest.Service
    const sessionID = Session.ID.make("ses_active_remote_checkpoint")
    const assistantMessageID = SessionMessage.ID.make("msg_active_remote_checkpoint")
    const session = yield* insertSession(db, store, sessionID)
    yield* activeToolTail(bus, sessionID, assistantMessageID, false)
    yield* bus.publish(SessionEvent.Compaction.Started, {
      sessionID,
      reason: "auto",
      recent: "",
      remote: true,
    })
    yield* bus.publish(SessionEvent.Compaction.RemoteItem, {
      sessionID,
      reset: true,
      item: { type: "compaction", id: "cmp_active", encrypted_content: "opaque" },
    })
    yield* bus.publish(SessionEvent.Compaction.RemoteItem, {
      sessionID,
      reset: false,
      item: { type: "function_call", id: "fc_active", call_id: "call_active_compaction", name: "read" },
    })
    yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "auto", text: "", recent: "" })

    const messages = yield* SessionHistory.load(db, sessionID)
    expect(messages.map((message) => message.type)).toEqual(["compaction", "assistant"])
    expect(messages[1]).toMatchObject({
      id: assistantMessageID,
      type: "assistant",
      content: [
        {
          type: "tool",
          id: "call_active_compaction",
          state: { status: "completed", content: [{ type: "text", text: "assembled tool result" }] },
        },
      ],
    })
    const prepared = yield* modelRequests.prepare({
      scope: { session, agentID: build, model: native },
      transcript: { system: [], messages: toLLMMessages(messages, native.ref) },
      contextHooks: false,
      includeSessionRules: false,
    })
    expect(prepared.request.model).toBe(nativeModel)
    expect(prepared.request.promptCacheKey).toBe(sessionID)
    expect(prepared.request.http?.headers).toMatchObject({
      "x-session-affinity": sessionID,
      "X-Session-Id": sessionID,
      "x-opencode-session": sessionID,
    })
    expect(JSON.stringify(prepared.request.messages)).toContain("assembled tool result")
  }),
)

function insertSession(db: Database.Interface["db"], store: SessionStore.Interface, sessionID: Session.ID) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: location.directory,
        title: sessionID,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    return yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
  })
}

function activeToolTail(
  bus: Bus.Interface,
  sessionID: Session.ID,
  assistantMessageID: SessionMessage.ID,
  executed = true,
) {
  return Effect.gen(function* () {
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: build,
      model: local.ref,
    })
    yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
    yield* bus.publish(SessionEvent.Text.Ended, {
      sessionID,
      assistantMessageID,
      ordinal: 0,
      text: "assembled crash-residue text",
    })
    yield* bus.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID,
      id: "call_active_compaction",
      name: "read",
    })
    yield* bus.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID,
      id: "call_active_compaction",
      text: '{"path":"README.md"}',
    })
    yield* bus.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID,
      id: "call_active_compaction",
      input: { path: "README.md" },
      executed,
    })
    yield* bus.publish(SessionEvent.Tool.Success, {
      sessionID,
      assistantMessageID,
      id: "call_active_compaction",
      content: [{ type: "text", text: "assembled tool result" }],
      executed,
    })
  })
}
