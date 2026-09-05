/** @jsxImportSource @opentui/solid */
import type { PluginInfo } from "@opencode-ai/client"
import type { Context, ToastOptions } from "@opencode-ai/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider } from "../../../src/context/location"
import { RouteProvider } from "../../../src/context/route"
import { ThemeProvider, useThemes } from "../../../src/context/theme"
import type { usePlugin } from "../../../src/plugin/context"
import "../../../src/plugin/context"
import { PluginsDialog } from "../../../src/feature-plugins/system/plugins"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { createApi, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const target = "git+ssh://git@github.com/example/team-plugins.git"

function packagePlugin(outdated: boolean): PluginInfo {
  return {
    id: "team.plugins",
    source: { type: "package", target, version: "dadba13", ...(outdated ? { outdated: true as const } : {}) },
    status: "active",
    tui: false,
  }
}

async function renderPlugins(root: string, input: { list: PluginInfo[]; check?: PluginInfo[] }) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const requests: { path: string; body: unknown }[] = []
  const toasts: ToastOptions[] = []
  const location = { directory: root, project: { id: "proj_test", directory: root, canonical: root } }
  let inventory = input.list
  const transport = createFetch(async (url, request) => {
    if (url.pathname === "/api/plugin") return json({ location, data: inventory })
    if (url.pathname === "/api/plugin/check") {
      requests.push({ path: url.pathname, body: await request.json() })
      inventory = input.check ?? inventory
      return json({ location, data: inventory })
    }
    if (url.pathname === "/api/plugin/update") {
      requests.push({ path: url.pathname, body: await request.json() })
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/api/plugin/await-activation") {
      requests.push({ path: url.pathname, body: undefined })
      inventory = inventory.map((plugin) =>
        plugin.source.type === "package"
          ? {
              ...plugin,
              source: {
                type: "package" as const,
                target: plugin.source.target,
                ...(plugin.source.version ? { version: plugin.source.version } : {}),
              },
            }
          : plugin,
      )
      return new Response(null, { status: 204 })
    }
  })
  const api = createApi(transport.fetch)

  function Harness() {
    function Content() {
      onCleanup(Keymap.use().mode.push("modal"))
      const theme = useThemes().currentTokens()
      const context = {
        client: api,
        data: { location: { default: () => ({ directory: root }) }, on: () => () => {} },
        get theme() {
          return theme
        },
        ui: {
          toast: { show: (toast: ToastOptions) => toasts.push(toast) },
          format: { path: (value: string) => value },
        },
      } as unknown as Context
      const plugins = {
        registered: () => [],
        list: () => [],
        server: () => [],
        activate: async () => true,
        deactivate: async () => true,
      } as unknown as ReturnType<typeof usePlugin>
      return <PluginsDialog context={context} plugins={plugins} />
    }

    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ConfigProvider config={createTuiResolvedConfig({ locale: "en" })}>
          <RouteProvider initialRoute={{ type: "home" }}>
            <ClientProvider api={api}>
              <DataProvider directory={root}>
                <LocationProvider>
                  <ThemeProvider mode="dark" source={emptyThemeSource}>
                    <Keymap.Provider>
                      <ToastProvider>
                        <DialogProvider>
                          <Content />
                        </DialogProvider>
                      </ToastProvider>
                    </Keymap.Provider>
                  </ThemeProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </RouteProvider>
        </ConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 24, kittyKeyboard: true })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(input.list[0]?.id ?? "Plugin"))
  return { app, requests, toasts }
}

test("check reveals update, update waits for activation, and the dialog refreshes", async () => {
  await using tmp = await tmpdir()
  const fixture = await renderPlugins(tmp.path, { list: [packagePlugin(false)], check: [packagePlugin(true)] })

  try {
    const initial = fixture.app.captureCharFrame()
    expect(initial).toContain("check for updates")
    expect(initial).not.toContain("update available")
    fixture.app.mockInput.pressKey("u", { ctrl: true })
    await fixture.app.flush()
    expect(fixture.requests).toEqual([])

    fixture.app.mockInput.pressKey("r", { ctrl: true })
    await fixture.app.waitForFrame((frame) => frame.includes("update available"))
    fixture.app.mockInput.pressKey("u", { ctrl: true })
    await fixture.app.waitFor(() => fixture.requests.length === 3)
    await fixture.app.waitForFrame((frame) => !frame.includes("update available"))

    expect(fixture.requests).toEqual([
      { path: "/api/plugin/check", body: {} },
      { path: "/api/plugin/update", body: { targets: [target] } },
      { path: "/api/plugin/await-activation", body: undefined },
    ])
    expect(fixture.toasts).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("local plugins have a local footer and no package check action", async () => {
  await using tmp = await tmpdir()
  const local: PluginInfo = {
    id: "local.plugin",
    source: { type: "local", path: path.join(tmp.path, "plugin", "index.ts") },
    status: "active",
    tui: true,
  }
  const fixture = await renderPlugins(tmp.path, { list: [local] })

  try {
    const frame = fixture.app.captureCharFrame()
    expect(frame).toContain("local")
    expect(frame).not.toContain("check for updates")
    fixture.app.mockInput.pressKey("r", { ctrl: true })
    await fixture.app.flush()
    expect(fixture.requests).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("failed built-ins are visible by default and expose flat error references", async () => {
  await using tmp = await tmpdir()
  const failed: PluginInfo = {
    id: "broken",
    source: { type: "builtin" },
    status: "failed",
    error: "Plugin disabled after transform failed",
    ref: "err_fixture",
    tui: false,
  }
  const fixture = await renderPlugins(tmp.path, { list: [failed] })

  try {
    expect(fixture.app.captureCharFrame()).toContain("broken")
    fixture.app.mockInput.pressEnter()
    const frame = await fixture.app.waitForFrame((value) => value.includes("err_fixture"))
    expect(frame).toContain("transform failed")
    expect(frame).toContain("×")
  } finally {
    fixture.app.renderer.destroy()
  }
})
