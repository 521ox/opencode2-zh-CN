import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Global } from "@opencode-ai/util/global"
import { Effect, FileSystem } from "effect"
import type { Locale } from "../src/i18n"
import { createEventStream, createFetch, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

type ViewCase = {
  locale: Locale
  home: string
  command: string
  group: string
  error: string
  title: string
  tokens: string
  number: string
  month: string
  weekday: string
  metrics: string[]
}

const cases: ViewCase[] = [
  {
    locale: "en",
    home: "commands",
    command: "Usage statistics",
    group: "System",
    error: "Could not load stats. Reopen /stats to try again.",
    title: "opencode / stats",
    tokens: "TOKENS",
    number: "92M",
    month: "Jan",
    weekday: "M",
    metrics: ["best streak", "active days", "sessions"],
  },
  {
    locale: "zh",
    home: "命令",
    command: "使用统计",
    group: "系统",
    error: "无法加载统计数据。请重新打开 /stats 后重试。",
    title: "opencode / 统计",
    tokens: "令牌",
    number: "9200万",
    month: "1月",
    weekday: "一",
    metrics: ["最长连续天数", "活跃天数", "会话"],
  },
]

test.each(cases)("stats shows this year and returns after errors or success ($locale)", async (view) => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 34, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const requests: URL[] = []
  const range = { from: new Date(new Date().getFullYear(), 0, 1).getTime(), to: Date.now() }
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/session/stats") return undefined
    requests.push(url)
    if (requests.length === 1) return json({ message: "offline" }, { status: 503 })
    return json({
      data: {
        range,
        sessions: 92_000_000,
        subagents: 0,
        prompts: 1,
        steps: 1,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 20, write: 0 } },
        cost: 0,
        tools: { mode: "none" },
        activeDays: 1,
        streak: 1,
        activity: [{ date: `${new Date().getFullYear()}-01-01`, steps: 1 }],
        models: [],
      },
    })
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, locale: view.locale, tabs: { enabled: false } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      args: {},
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    const commandRow = new RegExp(`${view.command}\\s+${view.group}`)
    const slashRow = new RegExp(`/stats\\s+${view.command}`)
    await setup.waitForFrame((frame) => frame.includes(view.home))
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    await setup.mockInput.typeText(view.command)
    await setup.waitForFrame((frame) => commandRow.test(frame))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes(view.error))
    setup.mockInput.pressEscape()
    await setup.waitFor(
      () =>
        setup.renderer.currentFocusedEditor instanceof TextareaRenderable &&
        !(setup.renderer.currentFocusedEditor instanceof InputRenderable),
    )
    await setup.waitForFrame((frame) => frame.includes(view.home) && !frame.includes(view.error))
    await setup.mockInput.typeText("/stats")
    await setup.waitForFrame((frame) => slashRow.test(frame))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes(view.tokens) && frame.includes(view.number))
    expect(requests[1].searchParams.get("tools")).toBe("none")
    expect(Number(requests[1].searchParams.get("from"))).toBe(new Date(new Date().getFullYear(), 0, 1).getTime())
    expect(requests[1].searchParams.has("to")).toBe(false)
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    const expectedDate = new Intl.DateTimeFormat(view.locale, { month: "short", year: "numeric" }).formatRange(
      new Date(range.from),
      new Date(range.to - 1),
    )
    expect(frame).toContain(view.title)
    expect(frame).toContain(expectedDate)
    expect(frame).toContain(view.number)
    view.metrics.forEach((metric) => expect(frame).toContain(metric))
    const weekday = lines.findIndex((line) => line.trimStart().startsWith(`${view.weekday}   `))
    expect(weekday).toBeGreaterThan(0)
    expect(lines[weekday - 1]).toContain(view.month)
    expect(frame).not.toContain("all time")
    expect(frame).not.toContain("All projects")
    expect(frame).not.toContain("show this year")
    expect(frame).not.toContain("esc")
    expect(lines.find((line) => line.includes(view.title))).not.toContain("tab")
    expect(requests).toHaveLength(2)
    expect(setup.captureCharFrame()).toContain(view.tokens)
    expect(setup.captureCharFrame()).not.toContain("headline")
    setup.mockInput.pressEscape()
    await setup.waitFor(
      () =>
        setup.renderer.currentFocusedEditor instanceof TextareaRenderable &&
        !(setup.renderer.currentFocusedEditor instanceof InputRenderable),
    )
    await setup.waitForFrame((frame) => frame.includes(view.home) && !frame.includes(view.title))
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await task.finally(() => server.stop(true))
  }
})
