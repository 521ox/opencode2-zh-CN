import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type Project, type SessionInfo } from "../src/promise"

const session = (viewed: number): SessionInfo => ({
  id: "ses_refresh",
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  outcome: "succeeded",
  time: { created: 0, updated: 0, idle: 2, viewed },
  location: { directory: "/project" },
})

const formFields = [{ key: "authorization", type: "external", url: "https://example.com" }] satisfies [
  { key: string; type: "external"; url: string },
]

function familySession(id: string, parentID?: string): SessionInfo {
  return {
    ...session(0),
    id,
    parentID,
    title: id,
  }
}

function durable(sessionID: string, seq = 1) {
  return { aggregateID: sessionID, seq, version: 1 as const }
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createSolidData(handler: (request: Request) => Response | Promise<Response>) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => handler(input instanceof Request ? input : new Request(input, init)),
  })
  const event: CreateDataInput["event"] = {
    on: () => () => {},
    listen(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }),
    dispose,
  }))

  return {
    data: setup.data,
    dispose: setup.dispose,
    emit(event: OpenCodeEvent) {
      listeners.forEach((listener) => listener({ name: event.type, details: event }))
    },
  }
}

test("revalidates after an event overtakes an active session read", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  let requests = 0
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session/ses_refresh")) throw new Error(`Unexpected request: ${request.url}`)
      requests++
      if (requests === 1) {
        await gate
        return Response.json({ data: session(1) })
      }
      return Response.json({ data: session(2) })
    },
  })
  const event: CreateDataInput["event"] = {
    on:
      <Type extends OpenCodeEvent["type"]>(
        _type: Type,
        _handler: (event: Extract<OpenCodeEvent, { type: Type }>) => void,
      ) =>
      () => {},
    listen(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }),
    dispose,
  }))

  try {
    setup.data.session.remember(session(1))
    setup.data.session.invalidate("ses_refresh")
    const initial = setup.data.session.sync("ses_refresh")
    await wait(() => requests === 1)

    const viewed: OpenCodeEvent = {
      id: "evt_viewed",
      created: 2,
      type: "session.viewed",
      durable: { aggregateID: "ses_refresh", seq: 1, version: 1 },
      data: { sessionID: "ses_refresh", idle: 2 },
    }
    listeners.forEach((listener) => listener({ name: viewed.type, details: viewed }))
    await Bun.sleep(20)
    release()
    await initial

    await wait(() => requests === 2 && setup.data.session.get("ses_refresh")?.time.viewed === 2)
  } finally {
    setup.dispose()
  }
})

test("updates authoritative cached project metadata from live events", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const original: Project = {
    id: "project_renamed",
    canonical: "/projects/original",
    name: "Original custom name",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  }
  const unrelated: Project = {
    id: "project_unrelated",
    canonical: "/projects/unrelated",
    name: "Unrelated project",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  }
  let requests = 0
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/project")) throw new Error(`Unexpected request: ${request.url}`)
      requests++
      return Response.json([original, unrelated])
    },
  })
  const event: CreateDataInput["event"] = {
    on: () => () => {},
    listen(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/projects/original", event }),
    dispose,
  }))

  try {
    await setup.data.project.sync()
    expect(setup.data.project.get(original.id)).toEqual(original)

    const updated: OpenCodeEvent = {
      id: "evt_project_renamed",
      created: 2,
      type: "project.updated",
      data: {
        ...original,
        canonical: "/projects/renamed",
        name: "Updated custom name",
        time: { ...original.time, updated: 2 },
      },
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))

    expect(setup.data.project.get(original.id)?.canonical).toBe("/projects/renamed")
    expect(setup.data.project.get(original.id)?.name).toBe("Updated custom name")
    expect(setup.data.project.get(unrelated.id)).toEqual(unrelated)
    expect(requests).toBe(1)

    const reset: OpenCodeEvent = {
      id: "evt_project_name_reset",
      created: 3,
      type: "project.updated",
      data: {
        id: original.id,
        canonical: "/projects/renamed-again",
        time: { ...original.time, updated: 3 },
        sandboxes: [],
      },
    }
    listeners.forEach((listener) => listener({ name: reset.type, details: reset }))

    expect(setup.data.project.get(original.id)?.canonical).toBe("/projects/renamed-again")
    expect(setup.data.project.get(original.id)?.name).toBeUndefined()
    expect(setup.data.project.get(unrelated.id)).toEqual(unrelated)
    expect(requests).toBe(1)
  } finally {
    setup.dispose()
  }
})

test("adopts cached directory-project sessions when their repository is resolved", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const refreshed: SessionInfo = {
    ...session(0),
    id: "ses_uncached",
    projectID: "repository",
    location: { directory: "/unknown-alias" },
    subpath: "app",
  }
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session/ses_uncached")) throw new Error(`Unexpected request: ${request.url}`)
      return Response.json({ data: refreshed })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/repo",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))

  try {
    const sessions: SessionInfo[] = [
      { ...session(0), id: "ses_root", projectID: "directory-root", location: { directory: "/repo" } },
      { ...session(0), id: "ses_nested", projectID: "directory-nested", location: { directory: "/repo/app" } },
      {
        ...session(0),
        id: "ses_alias",
        projectID: "directory-nested",
        location: { directory: "/repo/alias/../app" },
      },
      { ...session(0), id: "ses_symlink", projectID: "directory-nested", location: { directory: "/shortcut" } },
      { ...refreshed, projectID: "directory-uncached" },
      { ...session(0), id: "ses_global", projectID: "global", location: { directory: "/repo/legacy" } },
      { ...session(0), id: "ses_escaped", projectID: "global", location: { directory: "/repo/../other" } },
      { ...session(0), id: "ses_other", projectID: "other-repository", location: { directory: "/repo/vendor" } },
      { ...session(0), id: "ses_sibling", projectID: "global", location: { directory: "/repo-other" } },
      {
        ...session(0),
        id: "ses_remote",
        projectID: "directory-root",
        location: { directory: "/repo", workspaceID: "workspace-remote" },
      },
    ]
    sessions.forEach((item) => setup.data.session.remember(item))
    for (const project of [
      { id: "directory-root", canonical: "/repo" },
      { id: "directory-nested", canonical: "/repo/app" },
    ]) {
      const updated: OpenCodeEvent = {
        id: `evt_${project.id}`,
        created: 0,
        type: "project.updated",
        data: { ...project, time: { created: 0, updated: 0 }, sandboxes: [] },
      }
      listeners.forEach((listener) => listener({ name: updated.type, details: updated }))
    }

    const resolved: OpenCodeEvent = {
      id: "evt_repository_resolved",
      created: 1,
      type: "worktree.resolved",
      durable: { aggregateID: "repository", seq: 0, version: 1 },
      data: {
        projectID: "repository",
        directory: "/repo",
        previous: "global",
        adopted: ["directory-root", "directory-nested", "directory-uncached"],
      },
    }
    listeners.forEach((listener) => listener({ name: resolved.type, details: resolved }))

    expect(setup.data.session.get("ses_root")?.projectID).toBe("repository")
    expect(setup.data.session.get("ses_root")?.subpath).toBeUndefined()
    expect(setup.data.session.get("ses_nested")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_alias")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_symlink")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_global")).toMatchObject({ projectID: "repository", subpath: "legacy" })
    expect(setup.data.session.get("ses_escaped")?.projectID).toBe("global")
    expect(setup.data.session.get("ses_other")?.projectID).toBe("other-repository")
    expect(setup.data.session.get("ses_sibling")?.projectID).toBe("global")
    expect(setup.data.session.get("ses_remote")?.projectID).toBe("directory-root")
    await wait(() => setup.data.session.get("ses_uncached")?.projectID === "repository")
    expect(setup.data.session.get("ses_uncached")?.subpath).toBe("app")
  } finally {
    setup.dispose()
  }
})

test("refreshes global credential events across every loaded location and workspace", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: URL[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url)
      const directory = url.searchParams.get("location[directory]") ?? "/project"
      return Response.json({
        location: {
          directory,
          workspaceID: url.searchParams.get("location[workspace]") ?? undefined,
          project: { id: "project", directory, canonical: directory },
        },
        data: [],
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      connection: { status: () => "connected" },
    }),
    dispose,
  }))
  const locations = [{ directory: "/project" }, { directory: "/other", workspaceID: "workspace-other" }]

  try {
    await Promise.all(
      locations.flatMap((location) => [
        setup.data.location.integration.sync(location),
        setup.data.location.model.sync(location),
        setup.data.location.provider.sync(location),
      ]),
    )
    requests.length = 0

    const updated: OpenCodeEvent = {
      id: "evt_credential.updated",
      created: 1,
      type: "credential.updated",
      data: {},
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))
    await wait(() => requests.length === 2)
    expect(
      requests.map((url) => [
        url.pathname,
        url.searchParams.get("location[directory]"),
        url.searchParams.get("location[workspace]"),
      ]),
    ).toEqual([
      ["/api/integration", "/project", null],
      ["/api/integration", "/other", "workspace-other"],
    ])
    requests.length = 0

    for (const credentialID of ["credential", null]) {
      const switched: OpenCodeEvent = {
        id: `evt_credential.switched.${credentialID}`,
        created: 2,
        type: "credential.switched",
        data: { credentialID, integrationID: "integration" },
      }
      listeners.forEach((listener) => listener({ name: switched.type, details: switched }))
      await wait(() => requests.length === 4)
      expect(
        requests.map((url) => [
          url.pathname,
          url.searchParams.get("location[directory]"),
          url.searchParams.get("location[workspace]"),
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["/api/model", "/project", null],
          ["/api/provider", "/project", null],
          ["/api/model", "/other", "workspace-other"],
          ["/api/provider", "/other", "workspace-other"],
        ]),
      )
      requests.length = 0
    }
  } finally {
    setup.dispose()
  }
})

test("reports optimistic sessions as creating until the request settles", async () => {
  const release = Promise.withResolvers<void>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session")) throw new Error(`Unexpected request: ${request.url}`)
      await release.promise
      return Response.json({ data: session(0) })
    },
  })
  const event: CreateDataInput["event"] = {
    on: () => () => {},
    listen: () => () => {},
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }),
    dispose,
  }))

  try {
    const created = setup.data.session.create({ id: "ses_refresh", location: { directory: "/project" } })
    expect(setup.data.session.creating(created.id)).toBe(true)
    release.resolve()
    await created.request
    expect(setup.data.session.creating(created.id)).toBe(false)
  } finally {
    setup.dispose()
  }
})

test("loads bounded message pages", async () => {
  const requests: URL[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url)
      return Response.json({ data: [], cursor: requests.length === 1 ? { next: "next" } : {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: { on: () => () => {}, listen: () => () => {} },
    }),
    dispose,
  }))

  try {
    await setup.data.session.message.sync("ses_refresh")
    await setup.data.session.message.loadMore("ses_refresh")

    expect(requests).toHaveLength(2)
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({ limit: "20", order: "desc" })
    expect(Object.fromEntries(requests[1].searchParams)).toEqual({ cursor: "next", limit: "20" })
  } finally {
    setup.dispose()
  }
})

test("preserves assistant content replacement events across an active message read", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const release = Promise.withResolvers<void>()
  let requests = 0
  const content = [
    { type: "text" as const, text: "replacement" },
    { type: "reasoning" as const, text: "reasoning", time: { created: 3 } },
  ]
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async () => {
      const current = ++requests
      if (current === 2) await release.promise
      return Response.json({
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: current === 3 ? content : [{ type: "text", text: "original" }],
            time: { created: 1, completed: 2 },
          },
        ],
        cursor: {},
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))

  try {
    await setup.data.session.message.sync("ses_refresh")
    setup.data.session.message.invalidate("ses_refresh")
    const stale = setup.data.session.message.sync("ses_refresh")
    await wait(() => requests === 2)
    const updated: OpenCodeEvent = {
      id: "evt_message_updated",
      created: 3,
      type: "session.message.content.updated",
      durable: { aggregateID: "ses_refresh", seq: 3, version: 1 },
      data: {
        sessionID: "ses_refresh",
        messageID: "msg_assistant",
        content,
      },
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))

    expect(setup.data.session.message.list("ses_refresh")[0]).toMatchObject({ content })
    release.resolve()
    await stale
    await wait(() => requests === 3)
    expect(setup.data.session.message.list("ses_refresh")[0]).toMatchObject({ content })
  } finally {
    setup.dispose()
  }
})

test("releases an idle root family in memory and performs fresh family/message loads after rehydration", async () => {
  const sessions = {
    root: familySession("root"),
    child: familySession("child", "root"),
    sibling: familySession("sibling", "root"),
    grandchild: familySession("grandchild", "child"),
  }
  const infoCalls = new Map<string, number>()
  const familyCalls = new Map<string, number>()
  const messageCalls = new Map<string, number>()
  let deletes = 0
  const setup = createSolidData((request) => {
    const url = new URL(request.url)
    if (request.method === "DELETE") {
      deletes += 1
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/api/session") {
      const parentID = url.searchParams.get("parentID")
      if (!parentID) throw new Error(`Unexpected session list: ${request.url}`)
      familyCalls.set(parentID, (familyCalls.get(parentID) ?? 0) + 1)
      return Response.json({
        data: Object.values(sessions).filter((item) => item.parentID === parentID),
        cursor: {},
      })
    }
    const message = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/)
    if (message) {
      const sessionID = message[1]
      messageCalls.set(sessionID, (messageCalls.get(sessionID) ?? 0) + 1)
      return Response.json({
        data: [{ id: `msg_${sessionID}`, type: "user", text: sessionID, time: { created: 1 } }],
        cursor: { next: "older" },
      })
    }
    const inbox = url.pathname.match(/^\/api\/session\/([^/]+)\/inbox$/)
    if (inbox) return Response.json({ data: [] })
    const permission = url.pathname.match(/^\/api\/session\/([^/]+)\/permission$/)
    if (permission) return Response.json({ data: [] })
    const form = url.pathname.match(/^\/api\/session\/([^/]+)\/form$/)
    if (form) return Response.json({ data: [] })
    const match = url.pathname.match(/^\/api\/session\/([^/]+)$/)
    if (match && match[1] !== "active") {
      const sessionID = match[1]
      const info = Object.values(sessions).find((item) => item.id === sessionID)
      if (!info) throw new Error(`Unknown session: ${sessionID}`)
      infoCalls.set(sessionID, (infoCalls.get(sessionID) ?? 0) + 1)
      return Response.json({ data: info })
    }
    throw new Error(`Unexpected request: ${request.url}`)
  })

  try {
    await setup.data.session.sync("root", { children: true })
    await setup.data.session.sync("child", { children: true })
    const members = ["root", "child", "sibling", "grandchild"]
    for (const sessionID of members) {
      await setup.data.session.message.sync(sessionID)
      await setup.data.session.pending.sync(sessionID)
      await setup.data.session.permission.sync(sessionID)
      await setup.data.session.form.sync(sessionID)
    }
    expect(setup.data.session.family("root")).toEqual(members)
    expect(setup.data.session.message.more("root")).toBe(true)

    expect(setup.data.session.releaseWhenIdle("child")).toBe(true)
    for (const sessionID of members) {
      expect(setup.data.session.get(sessionID)).toBeUndefined()
      expect(setup.data.session.message.list(sessionID)).toEqual([])
      expect(setup.data.session.message.more(sessionID)).toBe(false)
      expect(setup.data.session.message.loading(sessionID)).toBe(false)
      expect(setup.data.session.pending.list(sessionID)).toEqual([])
      expect(setup.data.session.input.list(sessionID)).toEqual([])
      expect(setup.data.session.permission.list(sessionID)).toBeUndefined()
      expect(setup.data.session.form.list(sessionID)).toBeUndefined()
      expect(setup.data.session.status(sessionID)).toBe("idle")
    }
    expect(setup.data.session.family("root")).toEqual([])
    expect(deletes).toBe(0)

    await setup.data.session.sync("root", { children: true })
    await setup.data.session.sync("child", { children: true })
    await setup.data.session.message.sync("root")
    expect(setup.data.session.family("root")).toEqual(members)
    expect(setup.data.session.get("grandchild")?.id).toBe("grandchild")
    expect(setup.data.session.message.get("root", "msg_root")?.id).toBe("msg_root")
    expect(infoCalls.get("root")).toBe(2)
    expect(familyCalls.get("root")).toBe(2)
    expect(familyCalls.get("child")).toBe(2)
    expect(messageCalls.get("root")).toBe(2)
    expect(deletes).toBe(0)
  } finally {
    setup.dispose()
  }
})

test("defers a busy family release until execution, inbox, permission, and form lifecycle resolution", () => {
  const setup = createSolidData(() => {
    throw new Error("No API request expected")
  })
  const sessionID = "ses_busy"

  try {
    setup.data.session.remember(familySession(sessionID))
    setup.emit({
      id: "evt_execution_started",
      created: 1,
      type: "session.execution.started",
      durable: durable(sessionID),
      data: { sessionID },
    })
    expect(setup.data.session.releaseWhenIdle(sessionID)).toBe(false)
    expect(setup.data.session.get(sessionID)).toBeDefined()
    setup.emit({
      id: "evt_execution_succeeded",
      created: 2,
      type: "session.execution.succeeded",
      durable: durable(sessionID, 2),
      data: { sessionID },
    })
    expect(setup.data.session.get(sessionID)).toBeUndefined()

    setup.data.session.remember(familySession(sessionID))
    setup.emit({
      id: "evt_inbox_enqueued",
      created: 3,
      type: "session.inbox.enqueued",
      durable: durable(sessionID, 3),
      data: {
        sessionID,
        inboxID: "msg_pending",
        item: { type: "user", payload: { text: "wait" }, delivery: "queue" },
      },
    })
    expect(setup.data.session.releaseWhenIdle(sessionID)).toBe(false)
    expect(setup.data.session.pending.list(sessionID)).toHaveLength(1)
    setup.emit({
      id: "evt_inbox_cancelled",
      created: 4,
      type: "session.inbox.cancelled",
      durable: durable(sessionID, 4),
      data: { sessionID, inboxID: "msg_pending" },
    })
    expect(setup.data.session.get(sessionID)).toBeUndefined()

    setup.data.session.remember(familySession(sessionID))
    setup.emit({
      id: "evt_permission_asked",
      created: 5,
      type: "permission.asked",
      data: { id: "per_pending", sessionID, action: "read", resources: ["file.txt"] },
    })
    expect(setup.data.session.releaseWhenIdle(sessionID)).toBe(false)
    expect(setup.data.session.permission.list(sessionID)).toHaveLength(1)
    setup.emit({
      id: "evt_permission_replied",
      created: 6,
      type: "permission.replied",
      data: { sessionID, requestID: "per_pending", reply: "once" },
    })
    expect(setup.data.session.get(sessionID)).toBeUndefined()

    setup.data.session.remember(familySession(sessionID))
    setup.emit({
      id: "evt_form_created",
      created: 7,
      location: { directory: "/project" },
      type: "form.created",
      data: { form: { id: "frm_pending", sessionID, title: "Input", fields: formFields } },
    })
    expect(setup.data.session.releaseWhenIdle(sessionID)).toBe(false)
    expect(setup.data.session.form.list(sessionID)).toHaveLength(1)
    setup.emit({
      id: "evt_form_cancelled",
      created: 8,
      type: "form.cancelled",
      data: { sessionID, id: "frm_pending" },
    })
    expect(setup.data.session.get(sessionID)).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("retaining a family before it becomes idle cancels its pending release", () => {
  const sessionID = "ses_retain"
  const setup = createSolidData((request) => {
    if (new URL(request.url).pathname === `/api/session/${sessionID}`)
      return Response.json({ data: familySession(sessionID) })
    throw new Error("No API request expected")
  })

  try {
    setup.data.session.remember(familySession(sessionID))
    setup.emit({
      id: "evt_retain_started",
      created: 1,
      type: "session.execution.started",
      durable: durable(sessionID),
      data: { sessionID },
    })
    expect(setup.data.session.releaseWhenIdle(sessionID)).toBe(false)
    setup.data.session.retain(sessionID)
    setup.emit({
      id: "evt_retain_succeeded",
      created: 2,
      type: "session.execution.succeeded",
      durable: durable(sessionID, 2),
      data: { sessionID },
    })
    expect(setup.data.session.get(sessionID)?.id).toBe(sessionID)
    expect(setup.data.session.releaseWhenIdle(sessionID)).toBe(true)
    expect(setup.data.session.get(sessionID)).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("fences a delayed Session family response released before it resolves", async () => {
  const root = familySession("root")
  const child = familySession("child", "root")
  const infoGate = deferred<Response>()
  const familyGate = deferred<Response>()
  let infoRequests = 0
  let familyRequests = 0
  const setup = createSolidData((request) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/session/root") {
      infoRequests += 1
      return infoRequests === 1 ? infoGate.promise : Response.json({ data: root })
    }
    if (url.pathname === "/api/session" && url.searchParams.get("parentID") === "root") {
      familyRequests += 1
      return familyRequests === 1 ? familyGate.promise : Response.json({ data: [child], cursor: {} })
    }
    throw new Error(`Unexpected request: ${request.url}`)
  })

  try {
    const stale = setup.data.session.sync("root", { children: true })
    await wait(() => infoRequests === 1 && familyRequests === 1)
    expect(setup.data.session.releaseWhenIdle("root")).toBe(true)
    infoGate.resolve(Response.json({ data: root }))
    familyGate.resolve(Response.json({ data: [child], cursor: {} }))
    await stale

    expect(setup.data.session.get("root")).toBeUndefined()
    expect(setup.data.session.get("child")).toBeUndefined()
    expect(setup.data.session.family("root")).toEqual([])

    await setup.data.session.sync("root", { children: true })
    expect(infoRequests).toBe(2)
    expect(familyRequests).toBe(2)
    expect(setup.data.session.get("root")?.id).toBe("root")
    expect(setup.data.session.get("child")?.parentID).toBe("root")
  } finally {
    setup.dispose()
  }
})

test("fences delayed child message, pagination, pending, permission, and form responses after release", async () => {
  const root = familySession("root")
  const child = familySession("child", "root")
  const messageSyncGate = deferred<Response>()
  const messagePageGate = deferred<Response>()
  const pendingGate = deferred<Response>()
  const permissionGate = deferred<Response>()
  const formGate = deferred<Response>()
  let messageRequests = 0
  let delayedRequests = 0
  const setup = createSolidData((request) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/session/root") return Response.json({ data: root })
    if (url.pathname === "/api/session" && url.searchParams.get("parentID") === "root")
      return Response.json({ data: [child], cursor: {} })
    if (url.pathname === "/api/session/child/message") {
      messageRequests += 1
      if (messageRequests === 1)
        return Response.json({
          data: [{ id: "msg_current", type: "user", text: "current", time: { created: 2 } }],
          cursor: { next: "older" },
        })
      delayedRequests += 1
      return url.searchParams.has("cursor") ? messagePageGate.promise : messageSyncGate.promise
    }
    if (url.pathname === "/api/session/child/inbox") {
      delayedRequests += 1
      return pendingGate.promise
    }
    if (url.pathname === "/api/session/child/permission") {
      delayedRequests += 1
      return permissionGate.promise
    }
    if (url.pathname === "/api/session/child/form") {
      delayedRequests += 1
      return formGate.promise
    }
    throw new Error(`Unexpected request: ${request.url}`)
  })

  try {
    await setup.data.session.sync("root", { children: true })
    await setup.data.session.message.sync("child")
    setup.data.session.message.invalidate("child")
    const staleMessage = setup.data.session.message.sync("child")
    const stalePage = setup.data.session.message.loadMore("child")
    const stalePending = setup.data.session.pending.sync("child")
    const stalePermission = setup.data.session.permission.sync("child")
    const staleForm = setup.data.session.form.sync("child")
    await wait(() => delayedRequests === 5)
    expect(setup.data.session.message.loading("child")).toBe(true)
    expect(setup.data.session.releaseWhenIdle("root")).toBe(true)

    messageSyncGate.resolve(
      Response.json({ data: [{ id: "msg_stale", type: "user", text: "stale", time: { created: 1 } }], cursor: {} }),
    )
    messagePageGate.resolve(
      Response.json({ data: [{ id: "msg_older", type: "user", text: "older", time: { created: 0 } }], cursor: {} }),
    )
    pendingGate.resolve(
      Response.json({
        data: [
          {
            id: "msg_pending",
            sessionID: "child",
            timeCreated: 3,
            type: "user",
            payload: { text: "pending" },
            delivery: "queue",
          },
        ],
      }),
    )
    permissionGate.resolve(
      Response.json({ data: [{ id: "per_stale", sessionID: "child", action: "read", resources: ["file"] }] }),
    )
    formGate.resolve(
      Response.json({ data: [{ id: "frm_stale", sessionID: "child", title: "Input", fields: formFields }] }),
    )
    await Promise.all([staleMessage, stalePage, stalePending, stalePermission, staleForm])

    expect(setup.data.session.get("root")).toBeUndefined()
    expect(setup.data.session.get("child")).toBeUndefined()
    expect(setup.data.session.family("root")).toEqual([])
    expect(setup.data.session.message.list("child")).toEqual([])
    expect(setup.data.session.message.more("child")).toBe(false)
    expect(setup.data.session.message.loading("child")).toBe(false)
    expect(setup.data.session.pending.list("child")).toEqual([])
    expect(setup.data.session.input.list("child")).toEqual([])
    expect(setup.data.session.permission.list("child")).toBeUndefined()
    expect(setup.data.session.form.list("child")).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("session deletion fences delayed child info and message reads while a retained parent refreshes", async () => {
  const root = familySession("root")
  const child = familySession("child", "root")
  const childInfoGate = deferred<Response>()
  const childMessageGate = deferred<Response>()
  let childDeleted = false
  let rootRequests = 0
  let childInfoRequests = 0
  let childMessageRequests = 0
  const setup = createSolidData((request) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/session/root") {
      rootRequests += 1
      return Response.json({ data: root })
    }
    if (url.pathname === "/api/session/child") {
      childInfoRequests += 1
      return childInfoGate.promise
    }
    if (url.pathname === "/api/session" && url.searchParams.get("parentID") === "root")
      return Response.json({ data: childDeleted ? [] : [child], cursor: {} })
    if (url.pathname === "/api/session/child/message") {
      childMessageRequests += 1
      return childMessageGate.promise
    }
    throw new Error(`Unexpected request: ${request.url}`)
  })

  try {
    await setup.data.session.sync("root", { children: true })
    setup.data.session.retain("root")
    setup.data.session.invalidate("child")
    const staleInfo = setup.data.session.sync("child")
    const staleMessage = setup.data.session.message.sync("child")
    await wait(() => childInfoRequests === 1 && childMessageRequests === 1)

    childDeleted = true
    setup.emit({
      id: "evt_child_deleted",
      created: 1,
      type: "session.deleted",
      durable: durable("child"),
      data: { sessionID: "child" },
    })
    childInfoGate.resolve(Response.json({ data: child }))
    childMessageGate.resolve(
      Response.json({
        data: [{ id: "msg_child_stale", type: "user", text: "stale", time: { created: 1 } }],
        cursor: {},
      }),
    )
    await Promise.all([staleInfo, staleMessage])

    expect(setup.data.session.get("child")).toBeUndefined()
    expect(setup.data.session.message.list("child")).toEqual([])
    expect(setup.data.session.get("root")?.id).toBe("root")
    const beforeRefresh = rootRequests
    await setup.data.session.sync("root", { children: true })
    expect(rootRequests).toBe(beforeRefresh + 1)
    expect(setup.data.session.get("root")?.id).toBe("root")
    expect(setup.data.session.family("root")).toEqual(["root"])
  } finally {
    setup.dispose()
  }
})

test("keeps a fresh running family active when a stale active preload resolves", async () => {
  const sessionID = "ses_active_stale"
  const sentinelID = "ses_active_sentinel"
  const activeGate = deferred<Response>()
  let activeRequests = 0
  let sessionRequests = 0
  const setup = createSolidData((request) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/session/active") {
      activeRequests += 1
      return activeGate.promise
    }
    if (url.pathname === `/api/session/${sessionID}`) {
      sessionRequests += 1
      return Response.json({ data: familySession(sessionID) })
    }
    if (url.pathname === "/api/location")
      return Response.json({
        directory: "/project",
        project: { id: "project", directory: "/project", canonical: "/project" },
      })
    if (url.pathname === "/api/vcs")
      return Response.json({
        location: { directory: "/project" },
        data: { branch: { current: "main", default: "main" } },
      })
    if (url.pathname === "/api/project") return Response.json([])
    throw new Error(`Unexpected request: ${request.url}`)
  })

  try {
    setup.data.session.remember(familySession(sessionID))
    setup.data.session.remember(familySession(sentinelID))
    setup.emit({ id: "evt_connected", created: 1, type: "server.connected", data: {} })
    await wait(() => activeRequests === 1)

    expect(setup.data.session.releaseWhenIdle(sessionID)).toBe(true)
    setup.data.session.retain(sessionID)
    await setup.data.session.sync(sessionID)
    expect(sessionRequests).toBe(1)
    setup.emit({
      id: "evt_fresh_started",
      created: 2,
      type: "session.execution.started",
      durable: durable(sessionID),
      data: { sessionID },
    })

    activeGate.resolve(Response.json({ data: { [sentinelID]: { type: "running" } } }))
    await wait(() => setup.data.session.status(sentinelID) === "running")
    expect(setup.data.session.status(sessionID)).toBe("running")
    expect(setup.data.session.releaseWhenIdle(sessionID)).toBe(false)
  } finally {
    setup.dispose()
  }
})

test("flushes a pending family release when an optimistic prompt rejects before admission", async () => {
  const sessionID = "ses_prompt_rejected"
  const promptGate = deferred<Response>()
  let promptRequests = 0
  const setup = createSolidData((request) => {
    if (new URL(request.url).pathname !== `/api/session/${sessionID}/prompt`)
      throw new Error(`Unexpected request: ${request.url}`)
    promptRequests += 1
    return promptGate.promise
  })

  try {
    setup.data.session.remember(familySession(sessionID))
    const prompt = setup.data.session.prompt({ sessionID, id: "msg_rejected", text: "reject me" })
    await wait(() => promptRequests === 1)
    expect(setup.data.session.pending.list(sessionID)).toHaveLength(1)
    expect(setup.data.session.releaseWhenIdle(sessionID)).toBe(false)

    promptGate.reject(new Error("prompt rejected"))
    const error = await prompt.then(
      () => undefined,
      (error) => error,
    )
    expect(error).toBeDefined()
    expect(setup.data.session.get(sessionID)).toBeUndefined()
    expect(setup.data.session.family(sessionID)).toEqual([])
    expect(setup.data.session.pending.list(sessionID)).toEqual([])
    expect(setup.data.session.input.list(sessionID)).toEqual([])
    expect(setup.data.session.message.list(sessionID)).toEqual([])
  } finally {
    setup.dispose()
  }
})

test("moves a pending orphan release to its resolved root and releases after execution completes", async () => {
  const childID = "ses_orphan_child"
  const rootID = "ses_orphan_root"
  const child = familySession(childID, rootID)
  const infoGate = deferred<Response>()
  let requests = 0
  const setup = createSolidData((request) => {
    if (new URL(request.url).pathname !== `/api/session/${childID}`)
      throw new Error(`Unexpected request: ${request.url}`)
    requests += 1
    return requests === 1 ? infoGate.promise : Response.json({ data: child })
  })

  try {
    const initial = setup.data.session.sync(childID)
    await wait(() => requests === 1)
    setup.emit({
      id: "evt_orphan_started",
      created: 1,
      type: "session.execution.started",
      durable: durable(childID),
      data: { sessionID: childID },
    })
    expect(setup.data.session.releaseWhenIdle(childID)).toBe(false)

    infoGate.resolve(Response.json({ data: child }))
    await initial
    expect(setup.data.session.family(rootID)).toEqual([childID])
    setup.emit({
      id: "evt_orphan_succeeded",
      created: 2,
      type: "session.execution.succeeded",
      durable: durable(childID, 2),
      data: { sessionID: childID },
    })
    expect(setup.data.session.get(childID)).toBeUndefined()
    expect(setup.data.session.family(rootID)).toEqual([])

    await setup.data.session.sync(childID)
    expect(requests).toBe(2)
    expect(setup.data.session.get(childID)?.parentID).toBe(rootID)
  } finally {
    setup.dispose()
  }
})

test("admits an ownerless response-only active session on initial preload", async () => {
  const sessionID = "ses_ownerless_initial"
  const setup = createSolidData((request) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/session/active") return Response.json({ data: { [sessionID]: { type: "running" } } })
    if (url.pathname === "/api/location")
      return Response.json({
        directory: "/project",
        project: { id: "project", directory: "/project", canonical: "/project" },
      })
    if (url.pathname === "/api/vcs")
      return Response.json({
        location: { directory: "/project" },
        data: { branch: { current: "main", default: "main" } },
      })
    if (url.pathname === "/api/project") return Response.json([])
    throw new Error(`Unexpected request: ${request.url}`)
  })

  try {
    setup.emit({ id: "evt_ownerless_initial", created: 1, type: "server.connected", data: {} })
    await wait(() => setup.data.session.status(sessionID) === "running")
    expect(setup.data.session.get(sessionID)).toBeUndefined()
    expect(setup.data.session.family(sessionID)).toEqual([])
  } finally {
    setup.dispose()
  }
})

test("reconciles ownerless active sessions across reconnects", async () => {
  const previousID = "ses_ownerless_previous"
  const nextID = "ses_ownerless_next"
  let activeRequests = 0
  const setup = createSolidData((request) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/session/active") {
      activeRequests += 1
      return Response.json({
        data: activeRequests === 1 ? { [previousID]: { type: "running" } } : { [nextID]: { type: "running" } },
      })
    }
    if (url.pathname === "/api/location")
      return Response.json({
        directory: "/project",
        project: { id: "project", directory: "/project", canonical: "/project" },
      })
    if (url.pathname === "/api/vcs")
      return Response.json({
        location: { directory: "/project" },
        data: { branch: { current: "main", default: "main" } },
      })
    if (url.pathname === "/api/project") return Response.json([])
    throw new Error(`Unexpected request: ${request.url}`)
  })

  try {
    setup.emit({ id: "evt_ownerless_first", created: 1, type: "server.connected", data: {} })
    await wait(() => setup.data.session.status(previousID) === "running")
    setup.emit({ id: "evt_ownerless_reconnect", created: 2, type: "server.connected", data: {} })
    await wait(() => activeRequests === 2 && setup.data.session.status(nextID) === "running")
    expect(setup.data.session.status(previousID)).toBe("idle")
    expect(setup.data.session.get(previousID)).toBeUndefined()
    expect(setup.data.session.get(nextID)).toBeUndefined()
  } finally {
    setup.dispose()
  }
})

test("does not overwrite a fresh family state for an initially uncaptured active response ID", async () => {
  const sessionID = "ses_active_uncaptured"
  const sentinelID = "ses_active_response_sentinel"
  const activeGate = deferred<Response>()
  let activeRequests = 0
  const setup = createSolidData((request) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/session/active") {
      activeRequests += 1
      return activeGate.promise
    }
    if (url.pathname === `/api/session/${sessionID}`) return Response.json({ data: familySession(sessionID) })
    if (url.pathname === "/api/location")
      return Response.json({
        directory: "/project",
        project: { id: "project", directory: "/project", canonical: "/project" },
      })
    if (url.pathname === "/api/vcs")
      return Response.json({
        location: { directory: "/project" },
        data: { branch: { current: "main", default: "main" } },
      })
    if (url.pathname === "/api/project") return Response.json([])
    throw new Error(`Unexpected request: ${request.url}`)
  })

  try {
    setup.emit({ id: "evt_uncaptured_connected", created: 1, type: "server.connected", data: {} })
    await wait(() => activeRequests === 1)
    setup.data.session.remember(familySession(sessionID))
    setup.emit({
      id: "evt_uncaptured_started",
      created: 2,
      type: "session.execution.started",
      durable: durable(sessionID),
      data: { sessionID },
    })
    expect(setup.data.session.status(sessionID)).toBe("running")
    setup.emit({
      id: "evt_uncaptured_succeeded",
      created: 3,
      type: "session.execution.succeeded",
      durable: durable(sessionID, 2),
      data: { sessionID },
    })
    expect(setup.data.session.status(sessionID)).toBe("idle")

    activeGate.resolve(Response.json({ data: { [sessionID]: { type: "running" }, [sentinelID]: { type: "running" } } }))
    await wait(() => setup.data.session.status(sentinelID) === "running")
    expect(setup.data.session.status(sessionID)).toBe("idle")
    expect(setup.data.session.get(sessionID)?.id).toBe(sessionID)
  } finally {
    setup.dispose()
  }
})

test("refreshes references only for the location named by the event", async () => {
  const requests: URL[] = []
  const setup = createSolidData((request) => {
    const url = new URL(request.url)
    requests.push(url)
    const directory = url.searchParams.get("location[directory]") ?? "/project"
    return Response.json({
      location: {
        directory,
        workspaceID: url.searchParams.get("location[workspace]") ?? undefined,
        project: { id: "project", directory, canonical: directory },
      },
      data: [],
    })
  })
  const other = { directory: "/other", workspaceID: "workspace-other" }
  try {
    await Promise.all([setup.data.location.reference.sync(), setup.data.location.reference.sync(other)])
    requests.length = 0
    setup.emit({
      id: "evt_reference_updated",
      created: 1,
      type: "reference.updated",
      location: other,
      data: {},
    })
    await wait(() => requests.length === 1)
    expect([
      requests[0]!.pathname,
      requests[0]!.searchParams.get("location[directory]"),
      requests[0]!.searchParams.get("location[workspace]"),
    ]).toEqual(["/api/reference", "/other", "workspace-other"])
  } finally {
    setup.dispose()
  }
})

test("preserves sibling catalog references when another location field changes", async () => {
  const location = { directory: "/project", project: { id: "project", directory: "/project", canonical: "/project" } }
  const setup = createSolidData((request) => {
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/reference")
      return Response.json({
        location,
        data: [{ name: "docs", path: "/docs", source: { type: "local", path: "/docs" } }],
      })
    if (pathname === "/api/vcs")
      return Response.json({ location, data: { branch: { current: "main", default: "main" } } })
    throw new Error(`Unexpected request: ${pathname}`)
  })
  try {
    await Promise.all([setup.data.location.reference.sync(), setup.data.location.vcs.sync()])
    const references = setup.data.location.reference.list()
    setup.emit({
      id: "evt_branch_updated",
      created: 1,
      type: "vcs.branch.updated",
      location,
      data: { branch: "feature" },
    })
    expect(setup.data.location.vcs.info()?.branch.current).toBe("feature")
    expect(setup.data.location.reference.list()).toBe(references)
  } finally {
    setup.dispose()
  }
})

async function wait(check: () => boolean) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for condition")
    await Bun.sleep(10)
  }
}
