/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { CloseButton } from "../../src/ui/dialog"
import { emptyThemeSource } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("renders a three-cell close icon and keeps the full hit target clickable", async () => {
  let closed = 0
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <CloseButton onClose={() => closed++} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 3, height: 1 },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("×"))
    expect(app.captureCharFrame()).toStartWith("  ×")

    await app.mockMouse.click(0, 0)
    expect(closed).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
