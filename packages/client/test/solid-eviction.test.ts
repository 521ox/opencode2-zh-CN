import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInfo } from "../src/promise"

test("evicts heavy family caches while preserving metadata, attention, status, and optimistic input", async () => {
  const release = Promise.withResolvers<Response>()
  const requests: string[] = []
  const setup = fixture(async (url) => {
    requests.push(url.pathname)
    if (url.pathname.endsWith("/prompt")) return release.promise
  })
  try {
    await setup.data.session.message.sync("ses_child")
    await setup.data.session.pending.sync("ses_child")
    setup.data.session.setStatus("ses_child", "running")
    setup.emit({
      id: "evt_permission",
      created: 1,
      type: "permission.asked",
      data: { id: "per_test", sessionID: "ses_child", action: "bash", resources: ["bun test"] },
    })
    const prompt = setup.data.session.prompt({ sessionID: "ses_child", id: "msg_local", text: "local" })
    await wait(() => requests.some((item) => item.endsWith("/prompt")))

    setup.data.session.evict("ses_parent")

    expect(setup.data.session.get("ses_parent")?.id).toBe("ses_parent")
    expect(setup.data.session.get("ses_child")?.parentID).toBe("ses_parent")
    expect(setup.data.session.family("ses_parent")).toEqual(["ses_parent", "ses_child"])
    expect(setup.data.session.status("ses_child")).toBe("running")
    expect(setup.data.session.permission.list("ses_child")?.[0]?.id).toBe("per_test")
    expect(setup.data.session.pending.list("ses_child").map((item) => item.id)).toEqual(["msg_local"])
    expect(setup.data.session.input.list("ses_child")).toEqual(["msg_local"])
    expect(setup.data.session.message.list("ses_child").map((item) => item.id)).toEqual(["msg_local"])
    expect(requests.some((item) => item.startsWith("/api/location") || item.startsWith("/api/mcp"))).toBe(false)

    setup.emit(enqueued("ses_child", "msg_local"))
    release.resolve(Response.json({ id: "msg_local" }))
    await prompt
  } finally {
    release.resolve(Response.json({ id: "msg_local" }))
    setup.dispose()
  }
})

test("eviction fences an in-flight family read and the next sync loads fresh data", async () => {
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let reads = 0
  const setup = fixture(async (url) => {
    if (!url.pathname.endsWith("/message")) return
    reads++
    if (reads !== 1) return
    requested.resolve()
    await release.promise
  })
  try {
    const stale = setup.data.session.message.sync("ses_child")
    await requested.promise
    setup.data.session.evict("ses_parent")
    release.resolve()
    await stale
    expect(setup.data.session.message.list("ses_child")).toEqual([])
    await setup.data.session.message.sync("ses_child")
    expect(reads).toBe(2)
    expect(setup.data.session.message.list("ses_child").map((item) => item.id)).toEqual(["msg_page"])
  } finally {
    release.resolve()
    setup.dispose()
  }
})

function info(id: string, parentID?: string): SessionInfo {
  return {
    id,
    parentID,
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/project" },
  }
}

function enqueued(sessionID: string, inboxID: string): OpenCodeEvent {
  return {
    id: `evt_${inboxID}`,
    created: 1,
    type: "session.inbox.enqueued",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, inboxID, item: { type: "user", delivery: "steer", payload: { text: "local" } } },
  }
}

function fixture(read?: (url: URL) => Promise<Response | void>) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const response = await read?.(url)
      if (response) return response
      const sessionID = url.pathname.split("/")[3]
      if (url.pathname.endsWith("/inbox")) return Response.json({ data: [] })
      return Response.json({
        data: [{ id: "msg_page", type: "user", text: sessionID, time: { created: 0 } }],
        cursor: {},
      })
    },
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
    data.session.remember(info("ses_parent"))
    data.session.remember(info("ses_child", "ses_parent"))
    return {
      data,
      dispose,
      emit: (details: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: details.type, details })),
    }
  })
}

async function wait(check: () => boolean) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for condition")
    await Bun.sleep(10)
  }
}
