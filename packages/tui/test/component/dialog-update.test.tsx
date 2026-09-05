/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { DialogUpdate } from "../../src/component/dialog-update"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import type { Locale } from "../../src/i18n"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const copy = {
  en: {
    title: "Update available",
    managed: "An update is available. Applying will restart the server and active sessions will be resumed.",
    manual: "An update is available. Applying will install the update but you will need to manually restart.",
    installing: "Installing OpenCode 2.0.0…",
    restarting: "Restarting the background service…",
    update: "Update",
    skip: "Skip",
    close: "close",
  },
  zh: {
    title: "有可用更新",
    managed: "有可用更新。应用后将重启服务器，并恢复活动会话。",
    manual: "有可用更新。应用后将安装更新，但你需要手动重启。",
    installing: "正在安装 OpenCode 2.0.0…",
    restarting: "正在重启后台服务…",
    update: "更新",
    skip: "跳过",
    close: "关闭",
  },
} as const

type Actions = {
  install: () => Promise<void>
  restart?: () => Promise<void>
}

async function renderDialog(locale: Locale, actions: Actions) {
  const key = `update:${locale}`

  function OpenDialog() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(
        () => <DialogUpdate dialogKey={key} version="2.0.0" install={actions.install} restart={actions.restart} />,
        undefined,
        { key },
      ),
    )
    return null
  }

  return testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ locale, animations: false })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <OpenDialog />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 20, kittyKeyboard: true },
  )
}

const compact = (frame: string) => frame.replace(/\s/g, "")

for (const locale of ["en", "zh"] as const) {
  const text = copy[locale]

  for (const managed of [false, true]) {
    test(`${locale} renders localized ${managed ? "managed" : "manual"} update copy`, async () => {
      const app = await renderDialog(locale, {
        install: async () => {},
        ...(managed ? { restart: async () => {} } : {}),
      })
      try {
        app.renderer.start()
        await app.waitForFrame((frame) => frame.includes(text.title))
        const rendered = app.captureCharFrame()
        const frame = compact(rendered)
        expect(frame).toContain(compact(text.title))
        expect(frame).toContain(compact(managed ? text.managed : text.manual))
        expect(rendered.split("\n").some((line) => line.includes(text.skip) && line.includes(text.update))).toBe(true)
        expect(frame).toContain("×")
      } finally {
        app.renderer.destroy()
      }
    })
  }

  test(`${locale} installs and restarts exactly once`, async () => {
    const installing = Promise.withResolvers<void>()
    const restarting = Promise.withResolvers<void>()
    let installs = 0
    let restarts = 0
    const app = await renderDialog(locale, {
      install: () => {
        installs++
        return installing.promise
      },
      restart: () => {
        restarts++
        return restarting.promise
      },
    })
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes(text.title))
      app.mockInput.pressKey("RETURN")
      await app.waitForFrame((frame) => frame.includes(text.installing))
      expect(installs).toBe(1)
      expect(restarts).toBe(0)

      installing.resolve()
      await app.waitForFrame((frame) => frame.includes(text.restarting))
      expect(installs).toBe(1)
      expect(restarts).toBe(1)

      restarting.resolve()
      await app.waitForFrame((frame) => !frame.includes(text.title))
      expect(installs).toBe(1)
      expect(restarts).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test(`${locale} skip closes without installing`, async () => {
    let installs = 0
    const app = await renderDialog(locale, {
      install: async () => {
        installs++
      },
    })
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes(text.title))
      app.mockInput.pressKey("ARROW_RIGHT")
      await app.renderOnce()
      app.mockInput.pressKey("RETURN")
      await app.waitForFrame((frame) => !frame.includes(text.title))
      expect(installs).toBe(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test(`${locale} apply failure keeps localized UI and does not restart`, async () => {
    let installs = 0
    let restarts = 0
    const app = await renderDialog(locale, {
      install: async () => {
        installs++
        throw new Error("Registry denied the update")
      },
      restart: async () => {
        restarts++
      },
    })
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes(text.title))
      app.mockInput.pressKey("RETURN")
      await app.waitForFrame((frame) => frame.includes("Registry denied the update"))
      const frame = compact(app.captureCharFrame())
      expect(frame).toContain(compact(text.title))
      expect(frame).toContain(compact(text.close))
      expect(frame).toContain(compact("Registry denied the update"))
      expect(installs).toBe(1)
      expect(restarts).toBe(0)
    } finally {
      app.renderer.destroy()
    }
  })
}
