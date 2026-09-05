import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent } from "../src/promise"

const sessionID = "ses_compaction"
const base = {
  id: "evt_compaction",
  created: 10,
  durable: { aggregateID: sessionID, seq: 1, version: 1 as const },
  location: { directory: "/project" },
}

test("projects compaction model and provider state onto the running message", () => {
  const fixture = setup()
  try {
    fixture.emit({
      ...base,
      type: "session.compaction.started",
      data: { sessionID, inputID: "msg_compaction", reason: "manual", recent: "Before" },
    })
    const running = fixture.data.session.message.list(sessionID)[0]
    const model = { providerID: "demo", id: "summary-model" }
    const providerState = { responseId: "summary-response" }

    fixture.emit({
      ...base,
      id: "evt_compaction_ended",
      created: 20,
      durable: { aggregateID: sessionID, seq: 2, version: 1 },
      type: "session.compaction.ended",
      data: { sessionID, reason: "manual", model, providerState, text: "Summary", recent: "Recent" },
    })

    expect(fixture.data.session.message.list(sessionID)[0]).toBe(running)
    expect(fixture.data.session.message.list(sessionID)).toMatchObject([
      {
        id: "msg_compaction",
        type: "compaction",
        status: "completed",
        reason: "manual",
        model,
        providerState,
        summary: "Summary",
        recent: "Recent",
      },
    ])
  } finally {
    fixture.dispose()
  }
})

test("appends a completed compaction when no running message exists and accepts missing optional state", () => {
  const fixture = setup()
  try {
    fixture.emit({
      ...base,
      type: "session.compaction.ended",
      data: { sessionID, reason: "auto", text: "Summary", recent: "Recent" },
    })

    expect(fixture.data.session.message.list(sessionID)).toEqual([
      {
        id: "msg_compaction",
        type: "compaction",
        status: "completed",
        reason: "auto",
        model: undefined,
        providerState: undefined,
        summary: "Summary",
        recent: "Recent",
        time: { created: 10 },
      },
    ])
  } finally {
    fixture.dispose()
  }
})

function setup() {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: () => Promise.reject(new Error("Unexpected request")),
  })
  return createRoot((dispose) => {
    const data = createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    })
    return {
      data,
      dispose,
      emit(details: OpenCodeEvent) {
        listeners.forEach((listener) => listener({ name: details.type, details }))
      },
    }
  })
}
