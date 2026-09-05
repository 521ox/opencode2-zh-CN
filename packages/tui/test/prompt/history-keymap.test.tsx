/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { ConfigProvider } from "../../src/config"
import { navigatePromptHistory } from "../../src/component/prompt/history-navigation"
import { Keymap } from "../../src/context/keymap"
import { PromptHistoryProvider, usePromptHistory } from "../../src/prompt/history"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

async function wait(label: string, fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

test("down returns to session navigation after prompt history", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  const entries = [
    { text: "older", files: [], agents: [], skills: [], pasted: [] },
    { text: "latest", files: [], agents: [], skills: [], pasted: [] },
  ]
  await writeFile(
    path.join(state, "prompt-history.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  )

  let area: TextareaRenderable | undefined
  let historyApi: ReturnType<typeof usePromptHistory> | undefined
  let childCalls = 0
  let parentCalls = 0

  function Harness() {
    const history = usePromptHistory()
    historyApi = history
    Keymap.createLayer(() => ({
      commands: [
        { id: "session.child.first", run: () => void childCalls++ },
        { id: "session.parent", run: () => void parentCalls++ },
      ],
    }))
    Keymap.createLayer(() => ({
      priority: 1,
      target: () => area,
      commands: [
        {
          id: "prompt.history.previous",
          run() {
            if (!area) return false
            return navigatePromptHistory(-1, area, history, () => {})
          },
        },
        {
          id: "prompt.history.next",
          run() {
            if (!area) return false
            return navigatePromptHistory(1, area, history, () => {})
          },
        },
      ],
    }))
    return <textarea ref={(value) => (area = value)} focused={true} />
  }

  const app = await testRender(() => (
    <TestTuiContexts directory={tmp.path} paths={{ state }}>
      <ConfigProvider config={createTuiResolvedConfig()}>
        <Keymap.Provider>
          <PromptHistoryProvider>
            <Harness />
          </PromptHistoryProvider>
        </Keymap.Provider>
      </ConfigProvider>
    </TestTuiContexts>
  ))
  app.renderer.start()

  try {
    await wait("textarea", () => area instanceof TextareaRenderable)
    await Bun.sleep(20)

    app.mockInput.pressArrow("up")
    await wait("latest history item", () => area?.plainText === "latest")

    app.mockInput.pressArrow("up")
    await wait("older history item", () => area?.plainText === "older")

    app.mockInput.pressArrow("down")
    await wait("latest history item", () => area?.plainText === "latest")

    app.mockInput.pressArrow("down")
    await wait("empty prompt", () => area?.plainText === "")
    expect(childCalls).toBe(0)

    app.mockInput.pressArrow("down")
    await wait("session child command", () => childCalls === 1)

    app.mockInput.pressArrow("up")
    await wait("recalled history item", () => area?.plainText === "latest")
    area!.setText("edited latest")
    area!.cursorOffset = area!.plainText.length
    expect(historyApi!.state(area!.plainText)).toBe("edited")

    app.mockInput.pressArrow("down")
    await wait("edited history reset after down", () => historyApi?.state(area!.plainText) === "idle")
    expect(childCalls).toBe(1)

    app.mockInput.pressArrow("down")
    await wait("normal child command after edit reset", () => childCalls === 2)

    area!.setText("")
    area!.cursorOffset = 0
    app.mockInput.pressArrow("up")
    await wait("recalled history item for up", () => area?.plainText === "latest")
    area!.setText("edited latest")
    area!.cursorOffset = area!.plainText.length
    expect(historyApi!.state(area!.plainText)).toBe("edited")

    app.mockInput.pressArrow("up")
    await wait("edited history reset after up", () => historyApi?.state(area!.plainText) === "idle")
    expect(area!.cursorOffset).toBe(0)
    expect(parentCalls).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})
