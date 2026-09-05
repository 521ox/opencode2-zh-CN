/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { MouseButton, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode-ai/plugin/tui/context"
import { I18nProvider } from "../../src/context/i18n"
import { SidebarMcp } from "../../src/feature-plugins/sidebar/mcp"

type Status = "connected" | "failed" | "disabled"

function context(opened: Array<() => unknown>, status: Status = "connected") {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    theme: {
      text: {
        default: color,
        subdued: color,
        feedback: {
          success: { default: color },
          error: { default: color },
          warning: { default: color },
        },
      },
    },
    data: {
      session: { get: () => ({ location: { directory: "/workspace" } }) },
      location: {
        mcp: {
          server: {
            list: () => [
              {
                name: "alpha",
                status: status === "failed" ? { status, error: "Connection closed" } : { status },
              },
            ],
          },
        },
      },
    },
    ui: { dialog: { show: (render: () => unknown) => opened.push(render) } },
  } as unknown as Context
}

async function renderSidebar(status: Status = "connected") {
  const opened: Array<() => unknown> = []
  const app = await testRender(
    () => (
      <I18nProvider locale="en">
        <SidebarMcp context={context(opened, status)} sessionID="session" />
      </I18nProvider>
    ),
    { width: 42, height: 3 },
  )
  await app.renderOnce()
  const lines = app.captureCharFrame().split("\n")
  const row = lines.findIndex((line) => line.includes("alpha"))
  const line = lines[row] ?? ""
  const label = status === "failed" ? "Error" : status === "disabled" ? "Disabled" : "Connected"
  return { app, opened, row, nameX: line.indexOf("alpha"), statusX: line.indexOf(label), label }
}

test("MCP sidebar reserves names for selection and opens from the status target", async () => {
  const fixture = await renderSidebar()
  try {
    expect(fixture.row).toBeGreaterThan(-1)
    expect(fixture.nameX).toBeGreaterThan(-1)
    expect(fixture.statusX).toBeGreaterThan(-1)

    await fixture.app.mockMouse.click(fixture.nameX, fixture.row)
    expect(fixture.opened).toHaveLength(0)

    await fixture.app.mockMouse.drag(fixture.nameX, fixture.row, fixture.nameX + 3, fixture.row)
    expect(fixture.app.renderer.getSelection()?.getSelectedText()).not.toBe("")
    expect(fixture.opened).toHaveLength(0)

    await fixture.app.mockMouse.pressDown(fixture.statusX, fixture.row)
    await fixture.app.mockMouse.release(fixture.nameX, fixture.row)
    expect(fixture.opened).toHaveLength(0)

    await fixture.app.mockMouse.pressDown(fixture.statusX, fixture.row)
    await fixture.app.mockMouse.emitMouseEvent("drag", fixture.nameX, fixture.row)
    await fixture.app.mockMouse.release(fixture.nameX, fixture.row)
    expect(fixture.opened).toHaveLength(0)

    await fixture.app.mockMouse.pressDown(fixture.nameX, fixture.row)
    await fixture.app.mockMouse.emitMouseEvent("drag", fixture.statusX, fixture.row)
    await fixture.app.mockMouse.release(fixture.statusX, fixture.row)
    expect(fixture.opened).toHaveLength(0)

    await fixture.app.mockMouse.click(fixture.statusX, fixture.row)
    expect(fixture.opened).toHaveLength(1)

    await fixture.app.mockMouse.click(fixture.statusX, fixture.row, MouseButton.RIGHT)
    await fixture.app.mockMouse.scroll(fixture.statusX, fixture.row, "down")
    expect(fixture.opened).toHaveLength(1)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("MCP sidebar failed status opens the existing detail dialog", async () => {
  const fixture = await renderSidebar("failed")
  try {
    expect(fixture.app.captureCharFrame()).toContain(fixture.label)
    await fixture.app.mockMouse.click(fixture.statusX, fixture.row)
    expect(fixture.opened).toHaveLength(1)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("MCP sidebar disabled status remains an explicit detail target", async () => {
  const fixture = await renderSidebar("disabled")
  try {
    expect(fixture.app.captureCharFrame()).toContain(fixture.label)
    await fixture.app.mockMouse.click(fixture.statusX, fixture.row)
    expect(fixture.opened).toHaveLength(1)
  } finally {
    fixture.app.renderer.destroy()
  }
})
