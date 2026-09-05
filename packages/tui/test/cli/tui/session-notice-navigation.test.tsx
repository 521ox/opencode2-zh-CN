/** @jsxImportSource @opentui/solid */
import { BoxRenderable, TextAttributes, TextRenderable, type CapturedFrame, type CapturedSpan } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../../../src/config"
import { useRoute, RouteProvider } from "../../../src/context/route"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { SessionNoticeCompletionRow } from "../../../src/routes/session"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

type NoticeProps = Parameters<typeof SessionNoticeCompletionRow>[0]

function text(value: unknown) {
  expect(value).toBeInstanceOf(TextRenderable)
  if (!(value instanceof TextRenderable)) throw new Error("Expected a text renderable")
  return value
}

function box(value: unknown) {
  expect(value).toBeInstanceOf(BoxRenderable)
  if (!(value instanceof BoxRenderable)) throw new Error("Expected a box renderable")
  return value
}

function span(frame: CapturedFrame, value: string) {
  const result = frame.lines.flatMap((line) => line.spans).find((item) => item.text.includes(value))
  expect(result).toBeDefined()
  if (!result) throw new Error(`Expected a captured span containing ${value}`)
  return result
}

function style(value: CapturedSpan) {
  return {
    fg: value.fg.toInts(),
    bg: value.bg.toInts(),
    attributes: value.attributes,
  }
}

async function renderNotice(overrides: Partial<NoticeProps> = {}) {
  const parentNavigations: Array<[NoticeProps["target"], string]> = []
  let route: ReturnType<typeof useRoute> | undefined
  let theme: ReturnType<typeof useTheme> | undefined
  const props: NoticeProps = {
    source: "subagent",
    target: { source: "subagent", id: "child-session" },
    beforeMessageID: "completion-message",
    heading: "↳ General finished",
    description: "Fix final response sealing",
    state: "completed",
    width: 72,
    onParentNavigate: (target, beforeMessageID) => parentNavigations.push([target, beforeMessageID]),
    ...overrides,
  }
  const Notice = () => {
    route = useRoute()
    theme = useTheme()
    return <SessionNoticeCompletionRow {...props} />
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ locale: "en" })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <RouteProvider initialRoute={{ type: "session", sessionID: "parent-session" }}>
              <Notice />
            </RouteProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: props.width, height: 2 },
  )
  app.renderer.start()
  const frame = await app.waitForFrame((value) => value.includes(props.heading))
  const line = frame.split("\n")[0] ?? ""
  return {
    app,
    line,
    row: 0,
    headingX: line.indexOf(props.heading),
    separatorX: line.indexOf(" · "),
    titleX: props.description ? Math.max(line.indexOf(props.description), line.indexOf(" · ") + 3) : -1,
    parentNavigations,
    route: () => route!,
    theme: () => theme!,
    props,
  }
}

test("subagent completion status and title navigate to their distinct owners", async () => {
  const fixture = await renderNotice()
  try {
    await fixture.app.mockMouse.click(fixture.headingX + 2, fixture.row)
    expect(fixture.parentNavigations).toEqual([[{ source: "subagent", id: "child-session" }, "completion-message"]])
    expect(fixture.route().data).toEqual({ type: "session", sessionID: "parent-session" })

    await fixture.app.mockMouse.click(fixture.titleX + 2, fixture.row)
    expect(fixture.route().data).toEqual({ type: "session", sessionID: "child-session" })
    expect(fixture.parentNavigations).toHaveLength(1)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("only the subagent description gains a visible and reversible link hover", async () => {
  const fixture = await renderNotice()
  try {
    const outer = box(fixture.app.renderer.root.getRenderable("subagent-completion:child-session"))
    const children = outer.getChildren()
    const heading = text(children[0]?.getChildren()[0])
    const title = text(children[2]?.getChildren()[0])
    expect(title.fg.toInts()).toEqual(fixture.theme().text.action.primary.default.toInts())
    expect(title.fg.toInts()).not.toEqual(heading.fg.toInts())
    const defaultFrame = fixture.app.captureSpans()
    const defaultTitle = style(span(defaultFrame, fixture.props.description))
    const defaultHeading = style(span(defaultFrame, fixture.props.heading))
    const defaultSeparator = style(span(defaultFrame, " · "))
    expect(defaultTitle.attributes & TextAttributes.UNDERLINE).toBe(0)

    await fixture.app.mockMouse.moveTo(fixture.titleX + 1, fixture.row)
    await fixture.app.renderOnce()
    const hoverFrame = fixture.app.captureSpans()
    const hoverTitle = style(span(hoverFrame, fixture.props.description))
    expect(title.fg.toInts()).toEqual(fixture.theme().text.action.primary.hovered.toInts())
    expect(heading.fg.toInts()).toEqual(fixture.theme().text.feedback.info.default.toInts())
    expect(hoverTitle).not.toEqual(defaultTitle)
    expect(hoverTitle.attributes & TextAttributes.UNDERLINE).toBe(TextAttributes.UNDERLINE)
    expect(hoverTitle.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    expect(style(span(hoverFrame, fixture.props.heading))).toEqual(defaultHeading)
    expect(style(span(hoverFrame, " · "))).toEqual(defaultSeparator)

    await fixture.app.mockMouse.moveTo(0, 1)
    await fixture.app.renderOnce()
    const restoredFrame = fixture.app.captureSpans()
    expect(style(span(restoredFrame, fixture.props.description))).toEqual(defaultTitle)
    expect(style(span(restoredFrame, fixture.props.heading))).toEqual(defaultHeading)
    expect(style(span(restoredFrame, " · "))).toEqual(defaultSeparator)

    await fixture.app.mockMouse.click(fixture.separatorX + 1, fixture.row)
    expect(fixture.route().data).toEqual({ type: "session", sessionID: "parent-session" })
    expect(fixture.parentNavigations).toHaveLength(0)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("drag-selecting the subagent title does not navigate", async () => {
  const fixture = await renderNotice()
  try {
    await fixture.app.mockMouse.drag(fixture.titleX, fixture.row, fixture.titleX + 8, fixture.row)
    expect(fixture.app.renderer.getSelection()?.getSelectedText()).not.toBe("")
    expect(fixture.route().data).toEqual({ type: "session", sessionID: "parent-session" })
    expect(fixture.parentNavigations).toHaveLength(0)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("a narrow completion row truncates the title without merging its click target", async () => {
  const fixture = await renderNotice({ width: 28 })
  try {
    expect(fixture.line).toContain("↳ General finished · Fix")
    expect(fixture.line).not.toContain(fixture.props.description)
    await fixture.app.mockMouse.click(fixture.titleX, fixture.row)
    expect(fixture.route().data).toEqual({ type: "session", sessionID: "child-session" })
    expect(fixture.parentNavigations).toHaveLength(0)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("missing child identity or description never creates a child navigation target", async () => {
  const missingID = await renderNotice({ target: undefined })
  try {
    await missingID.app.mockMouse.click(missingID.titleX + 2, missingID.row)
    expect(missingID.route().data).toEqual({ type: "session", sessionID: "parent-session" })
    expect(missingID.parentNavigations).toHaveLength(0)
  } finally {
    missingID.app.renderer.destroy()
  }

  const missingDescription = await renderNotice({ description: "" })
  try {
    await missingDescription.app.mockMouse.click(missingDescription.separatorX + 1, missingDescription.row)
    expect(missingDescription.route().data).toEqual({ type: "session", sessionID: "parent-session" })
    expect(missingDescription.parentNavigations).toHaveLength(0)
  } finally {
    missingDescription.app.renderer.destroy()
  }
})

test("shell and failed subagent completions preserve their existing navigation targets", async () => {
  const shell = await renderNotice({
    source: "shell",
    target: { source: "shell", id: "job-1" },
    heading: "↳ Shell finished",
  })
  try {
    await shell.app.mockMouse.click(shell.titleX + 2, shell.row)
    expect(shell.parentNavigations).toEqual([[{ source: "shell", id: "job-1" }, "completion-message"]])
    expect(shell.route().data).toEqual({ type: "session", sessionID: "parent-session" })
  } finally {
    shell.app.renderer.destroy()
  }

  for (const state of ["error", "cancelled"] as const) {
    const subagent = await renderNotice({ state, heading: `! General ${state}` })
    try {
      const outer = subagent.app.renderer.root.getRenderable("subagent-completion:child-session")
      const heading = text(outer?.getChildren()[0]?.getChildren()[0])
      expect(heading.fg.toInts()).toEqual(
        (state === "error"
          ? subagent.theme().text.feedback.error.default
          : subagent.theme().text.feedback.warning.default
        ).toInts(),
      )
      await subagent.app.mockMouse.click(subagent.headingX + 2, subagent.row)
      expect(subagent.parentNavigations).toHaveLength(1)
      await subagent.app.mockMouse.click(subagent.titleX + 2, subagent.row)
      expect(subagent.route().data).toEqual({ type: "session", sessionID: "child-session" })
      expect(subagent.parentNavigations).toHaveLength(1)
    } finally {
      subagent.app.renderer.destroy()
    }
  }
})
