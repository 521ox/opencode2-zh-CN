/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import type { SessionMessageAssistantTool } from "@opencode-ai/client"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../../src/config"
import { I18nProvider } from "../../../src/context/i18n"
import { ThemeProvider } from "../../../src/context/theme"
import { DirectExec, GenericTool, toolDisplay } from "../../../src/routes/session"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

let app: Awaited<ReturnType<typeof testRender>> | undefined
type ToolProps = Parameters<typeof DirectExec>[0]

afterEach(() => {
  app?.renderer.destroy()
  app = undefined
})

function part(name: string, state: SessionMessageAssistantTool["state"]): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: `${name}-part`,
    name,
    state,
    time: { created: 0 },
  }
}

function props(
  options: {
    tool?: string
    input?: Record<string, string | string[]>
    output?: string
    status?: "running" | "completed" | "error"
  } = {},
): ToolProps {
  const tool = options.tool ?? "direct_exec"
  const input = options.input ?? {}
  const status = options.status ?? "completed"
  const state: SessionMessageAssistantTool["state"] =
    status === "running"
      ? { status, input, metadata: {} }
      : status === "error"
        ? { status, input, error: { type: "ProcessError", message: "Process failed" } }
        : { status, input, content: [{ type: "text", text: options.output ?? "" }] }
  return {
    tool,
    input,
    output: options.output,
    metadata: {},
    part: part(tool, state),
    permission: false,
  }
}

async function render(component: () => ReturnType<typeof DirectExec>) {
  app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <I18nProvider locale="en">{component()}</I18nProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 72, height: 12 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("direct_exec") || frame.includes("plugin_tool"))
  return app
}

function location(frame: string, text: string) {
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => line.includes(text))
  return { row, column: row < 0 ? -1 : lines[row].indexOf(text) }
}

describe("direct_exec TUI renderer", () => {
  test("classifies direct_exec without changing unknown generic tools", () => {
    expect(toolDisplay("direct_exec")).toBe("direct_exec")
    expect(toolDisplay("plugin_tool")).toBe("generic")
  })

  test("expands from the title and collapses from expanded details", async () => {
    const setup = await render(() =>
      DirectExec(props({ input: { args: ["status", "--short"], cwd: "/workspace" }, output: "clean tree" })),
    )
    const title = location(setup.captureCharFrame(), "direct_exec")
    expect(setup.captureCharFrame()).not.toContain("clean tree")

    await setup.mockMouse.click(title.column, title.row)
    await setup.renderOnce()
    const detail = location(setup.captureCharFrame(), "clean tree")
    expect(detail.row).toBeGreaterThan(-1)

    await setup.mockMouse.click(detail.column, detail.row)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("clean tree")
  })

  test("keeps details expanded when their text is selected", async () => {
    const setup = await render(() => DirectExec(props({ input: { cwd: "/workspace" }, output: "selected detail" })))
    const title = location(setup.captureCharFrame(), "direct_exec")
    await setup.mockMouse.click(title.column, title.row)
    await setup.renderOnce()
    const detail = location(setup.captureCharFrame(), "selected detail")

    await setup.mockMouse.drag(detail.column, detail.row, detail.column + "selected".length - 1, detail.row)
    await setup.renderOnce()
    expect(setup.renderer.getSelection()?.getSelectedText()).not.toBe("")
    expect(setup.captureCharFrame()).toContain("selected detail")
  })

  test("keeps unknown generic detail clicks outside the title owner", async () => {
    const setup = await render(() =>
      GenericTool(props({ tool: "plugin_tool", input: { query: "needle" }, output: "generic detail" })),
    )
    const title = location(setup.captureCharFrame(), "plugin_tool")
    await setup.mockMouse.click(title.column, title.row)
    await setup.renderOnce()
    const detail = location(setup.captureCharFrame(), "generic detail")
    expect(detail.row).toBeGreaterThan(-1)

    await setup.mockMouse.click(detail.column, detail.row)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("generic detail")
  })

  test("does not create an expansion target without input or output", async () => {
    const setup = await render(() => DirectExec(props()))
    const before = setup.captureCharFrame()
    const title = location(before, "direct_exec")
    await setup.mockMouse.click(title.column, title.row)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toBe(before)
  })

  test("keeps running and failure states visible while collapsed", async () => {
    const running = await render(() => DirectExec(props({ input: { args: ["status"] }, status: "running" })))
    expect(running.captureCharFrame()).toContain("direct_exec")
    running.renderer.destroy()
    app = undefined

    const failed = await render(() => DirectExec(props({ status: "error" })))
    expect(failed.captureCharFrame()).toContain("direct_exec")
    expect(failed.captureCharFrame()).toContain("Process failed")
  })
})
