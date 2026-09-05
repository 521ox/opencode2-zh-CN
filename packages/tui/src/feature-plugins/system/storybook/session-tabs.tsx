import { Plugin } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createSignal, For } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  EMPTY_SESSION_TAB_STATUS,
  SessionTabs,
  TAB_SPINNERS,
  TAB_UNREAD_MARKERS,
  type SessionTabsController,
  type TabSpinner,
  type TabUnreadMarker,
} from "../../../component/session-tabs"
import { closeSessionTab, cycleSessionTab, moveSessionTab } from "../../../context/session-tabs-model"
import { useI18n } from "../../../context/i18n"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

type FixtureStatus = ReturnType<SessionTabsController["status"]>

const FIXTURE_TABS = [
  { sessionID: "fixture-1", title: "Implement session tabs", project: "opencode" },
  { sessionID: "fixture-2", title: "Investigate rendering", project: "opencode" },
  { sessionID: "fixture-3", title: "A deliberately long session title for truncation", project: "opencode-slack" },
  { sessionID: "fixture-4", title: "Fix provider state", project: "opencode" },
  { sessionID: "fixture-5", title: "Review animation", project: "opencode-slack" },
  { sessionID: "fixture-6", title: "Untitled behavior", project: "opencode-drive" },
  { sessionID: "fixture-7", title: "Queue follow-up work", project: "opencode" },
  { sessionID: "fixture-8", title: "Check narrow layout", project: "opencode-drive" },
  { sessionID: "fixture-9", title: "Profile terminal output", project: "opencode" },
  { sessionID: "fixture-10", title: "Handle permission", project: "opencode-slack" },
  { sessionID: "fixture-11", title: "Run focused tests", project: "opencode" },
  { sessionID: "fixture-12", title: "Prepare review", project: "opencode-drive" },
]

const FIXTURE_STATUSES: Record<string, FixtureStatus> = {
  "fixture-2": { ...EMPTY_SESSION_TAB_STATUS, busy: true },
  "fixture-3": { ...EMPTY_SESSION_TAB_STATUS, busy: true, attention: "question" },
  "fixture-4": { ...EMPTY_SESSION_TAB_STATUS, busy: true, attention: "permission" },
  "fixture-5": { ...EMPTY_SESSION_TAB_STATUS, unread: "activity" },
  "fixture-6": { ...EMPTY_SESSION_TAB_STATUS, unread: "error" },
}
const FIXTURE_OUTCOMES = { "fixture-5": "completed", "fixture-6": "failed" } as const

// Plausible targets for the fake transcript's tool calls, picked per fixture index.
const TRANSCRIPT_FILES = [
  "packages/tui/src/component/session-tabs.tsx",
  "packages/tui/src/component/tab-pulse.tsx",
  "packages/tui/src/context/session-tabs-model.ts",
  "packages/core/src/session/runner.ts",
  "packages/server/src/routes/session.ts",
  "packages/tui/src/ui/animation.ts",
]

function SessionTabsStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const i18n = useI18n()
  // A keyed store mirrors production: retitles mutate rows in place instead of remounting them.
  const [tabStore, setTabStore] = createStore<{ items: { sessionID: string; title?: string }[] }>({
    items: FIXTURE_TABS.slice(0, 6).map((tab) => ({ ...tab })),
  })
  const tabs = () => tabStore.items
  const setItems = (next: { sessionID: string; title?: string }[]) =>
    setTabStore("items", reconcile(next, { key: "sessionID" }))
  const [active, setActive] = createSignal<string | undefined>("fixture-1")
  const [lastEvent, setLastEvent] = createSignal("idle / working / question / permission / complete / error")
  const [statuses, setStatuses] = createSignal<Record<string, FixtureStatus>>(FIXTURE_STATUSES)
  const [orientation, setOrientation] = createSignal<"horizontal" | "vertical">("vertical")
  const spinners = Object.keys(TAB_SPINNERS) as TabSpinner[]
  const [spinner, setSpinner] = createSignal<TabSpinner>("dots")
  const markers = Object.keys(TAB_UNREAD_MARKERS) as TabUnreadMarker[]
  const [marker, setMarker] = createSignal<TabUnreadMarker>("small-dot")
  const [animations, setAnimations] = createSignal(true)
  // Unread clears on select, so the transcript remembers how each session's last run ended.
  const [outcomes, setOutcomes] = createSignal<Record<string, "completed" | "failed">>(FIXTURE_OUTCOMES)
  const number = (sessionID: string) => tabs().findIndex((tab) => tab.sessionID === sessionID) + 1

  function finishRun(sessionID: string, failed = Math.random() >= 0.75) {
    if (!tabs().some((item) => item.sessionID === sessionID)) return
    const unread = active() === sessionID ? undefined : failed ? ("error" as const) : ("activity" as const)
    batch(() => {
      setOutcomes((current) => ({ ...current, [sessionID]: failed ? "failed" : "completed" }))
      setStatuses((current) => ({
        ...current,
        [sessionID]: { ...(current[sessionID] ?? EMPTY_SESSION_TAB_STATUS), busy: false, attention: false, unread },
      }))
      // An untitled session earns its title after its first completed run, like a real summarization.
      const index = number(sessionID) - 1
      const fixture = FIXTURE_TABS.find((tab) => tab.sessionID === sessionID)
      if (!failed && fixture && tabs()[index]?.title === undefined) setTabStore("items", index, "title", fixture.title)
    })
    setLastEvent(
      `tab ${number(sessionID)} ${failed ? "failed" : "completed"}${unread ? " (unread)" : " while selected"}`,
    )
  }

  const select = (sessionID: string) => {
    const status = statuses()[sessionID]
    batch(() => {
      setActive(sessionID)
      if (status?.unread) setStatuses((current) => ({ ...current, [sessionID]: { ...status, unread: undefined } }))
    })
  }

  const addTab = () => {
    const next = FIXTURE_TABS.find((fixture) => !tabs().some((tab) => tab.sessionID === fixture.sessionID))
    if (!next) {
      setLastEvent("all fixture tabs are open")
      return
    }
    setItems([...tabs().map((tab) => ({ ...tab })), { sessionID: next.sessionID }])
    select(next.sessionID)
    setLastEvent(`tab ${number(next.sessionID)} opened untitled; run it to earn its title`)
  }

  const controller = {
    tabs,
    current: active,
    add: addTab,
    detail(sessionID) {
      return FIXTURE_TABS.find((tab) => tab.sessionID === sessionID)?.project
    },
    status(sessionID) {
      return statuses()[sessionID] ?? EMPTY_SESSION_TAB_STATUS
    },
    select,
    move(sessionID: string, index: number) {
      const next = moveSessionTab(tabs(), sessionID, index)
      if (next === tabs()) return
      setItems(next.map((tab) => ({ ...tab })))
    },
    close(sessionID?: string) {
      const target = sessionID ?? active()
      if (!target) return
      const result = closeSessionTab(tabs(), target)
      if (result.tabs === tabs()) return
      batch(() => {
        setItems(result.tabs.map((tab) => ({ ...tab })))
        setStatuses((current) => {
          const updated = { ...current }
          delete updated[target]
          return updated
        })
        if (active() === target && result.next) select(result.next)
        if (active() === target && !result.next) setActive(undefined)
      })
    },
  } satisfies SessionTabsController

  const cycle = (direction: 1 | -1) => {
    const tab = cycleSessionTab(tabs(), active(), direction)
    if (tab) select(tab.sessionID)
  }
  const startRun = (sessionID: string) => {
    setStatuses((current) => ({
      ...current,
      [sessionID]: {
        ...(current[sessionID] ?? EMPTY_SESSION_TAB_STATUS),
        busy: true,
        attention: false,
        unread: undefined,
      },
    }))
    setOutcomes((current) => {
      const next = { ...current }
      delete next[sessionID]
      return next
    })
    setLastEvent(`tab ${number(sessionID)} running`)
  }
  const prompt = (sessionID: string) => {
    const wasBusy = controller.status(sessionID).busy
    setStatuses((current) => {
      const status = current[sessionID] ?? EMPTY_SESSION_TAB_STATUS
      return {
        ...current,
        [sessionID]: {
          ...status,
          busy: true,
          unread: undefined,
          promptPulse: status.promptPulse + 1,
        },
      }
    })
    setLastEvent(`prompt sent to tab ${number(sessionID)}${wasBusy ? " while running" : ""}`)
  }
  const randomInactiveTab = () => {
    const candidates = tabs().filter((tab) => {
      const status = controller.status(tab.sessionID)
      return !status.busy && !status.unread && !status.attention
    })
    // Untitled sessions run first so their title arrival is easy to trigger.
    const untitled = candidates.filter((tab) => tab.title === undefined)
    const pool = untitled.length > 0 ? untitled : candidates
    return pool[Math.floor(Math.random() * pool.length)]
  }
  const randomRunningTab = () => {
    const candidates = tabs().filter((tab) => {
      const status = controller.status(tab.sessionID)
      return status.busy && !status.attention
    })
    return candidates[Math.floor(Math.random() * candidates.length)]
  }
  // A fake transcript for the selected session so tab switches feel like moving between real
  // sessions; the tail line tracks the live status of the current run.
  const transcript = () => {
    const current = active()
    if (!current) return [{ text: "no session selected", color: theme.text.subdued }]
    const index = Math.max(
      0,
      FIXTURE_TABS.findIndex((fixture) => fixture.sessionID === current),
    )
    const fixture = FIXTURE_TABS[index]
    const status = controller.status(current)
    const outcome = outcomes()[current]
    const file = TRANSCRIPT_FILES[index % TRANSCRIPT_FILES.length]
    const lines = [
      { text: `> ${fixture.title}`, color: theme.text.default },
      { text: "", color: theme.text.default },
    ]
    if (!status.busy && !status.attention && outcome === undefined) {
      lines.push({ text: "no activity yet — press s to run this session", color: theme.text.subdued })
      return lines
    }
    lines.push(
      { text: "● Taking a look — reading the relevant code first.", color: theme.text.default },
      { text: "", color: theme.text.default },
      { text: `  ✱ Read ${file}`, color: theme.text.subdued },
      { text: `  ✱ Edit ${file}`, color: theme.text.subdued },
      { text: `  ✱ Bash bun run test`, color: theme.text.subdued },
      { text: "", color: theme.text.default },
    )
    if (status.attention === "question")
      lines.push({ text: "? Which approach should I take?", color: theme.text.status.question })
    else if (status.attention === "permission")
      lines.push({ text: "! Waiting for permission to run the command", color: theme.text.status.permission })
    else if (status.busy) lines.push({ text: "● Working…", color: theme.text.status.running })
    else if (outcome === "failed")
      lines.push({
        text: `✗ bun run test failed — 3 tests failing in ${file}`,
        color: theme.text.feedback.error.default,
      })
    else
      lines.push({
        text: `✓ Done — updated ${file} and the tests pass.`,
        color: theme.text.feedback.success.default,
      })
    return lines
  }

  const stateSummary = () => {
    const values = tabs().map((tab) => controller.status(tab.sessionID))
    const running = values.filter((status) => status.busy && !status.attention).length
    const waiting = values.filter((status) => status.attention).length
    const unread = values.filter((status) => status.unread !== undefined).length
    return [
      i18n.t("feature.storybook.summary.selected", { index: number(active() ?? "") }),
      i18n.t("feature.storybook.summary.running", { count: running }),
      i18n.t("feature.storybook.summary.waiting", { count: waiting }),
      i18n.t("feature.storybook.summary.unread", { count: unread }),
    ].join("  ·  ")
  }

  const reset = (showcase = false) => {
    batch(() => {
      setItems(FIXTURE_TABS.slice(0, 6).map((tab) => ({ ...tab })))
      setStatuses(showcase ? FIXTURE_STATUSES : {})
      setOutcomes(showcase ? FIXTURE_OUTCOMES : {})
      setActive("fixture-1")
      setSpinner("dots")
      setMarker("small-dot")
      setAnimations(true)
      setOrientation("vertical")
    })
    setLastEvent(showcase ? "all six states are visible" : "reset; all tabs idle")
  }

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: i18n.t("feature.storybook.command.backToStorybook"),
        group: i18n.t("feature.storybook.group"),
        run() {
          props.context.ui.router.navigate({ type: "plugin", name: "storybook" })
        },
      },
      {
        bind: "up,k,left,h",
        title: i18n.t("feature.storybook.command.previousTab"),
        group: i18n.t("feature.storybook.group"),
        run: () => cycle(-1),
      },
      {
        bind: "down,j,right,l",
        title: i18n.t("feature.storybook.command.nextTab"),
        group: i18n.t("feature.storybook.group"),
        run: () => cycle(1),
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        bind: `${(index + 1) % 10},ctrl+${(index + 1) % 10}`,
        title: i18n.t("feature.storybook.command.selectTab", { index: index + 1 }),
        group: i18n.t("feature.storybook.group"),
        run() {
          const tab = tabs()[index]
          if (tab) select(tab.sessionID)
        },
      })),
      {
        bind: "space",
        title: i18n.t("feature.storybook.command.startRandomTab"),
        group: i18n.t("feature.storybook.group"),
        run() {
          const tab = randomInactiveTab()
          if (!tab) {
            setLastEvent("every tab is busy or unread; select tabs to read them, or press r")
            return
          }
          startRun(tab.sessionID)
        },
      },
      {
        bind: "e",
        title: i18n.t("feature.storybook.command.endRandomRunningTab"),
        group: i18n.t("feature.storybook.group"),
        run() {
          const tab = randomRunningTab()
          if (!tab) {
            setLastEvent("no tabs are running; press space to start one")
            return
          }
          finishRun(tab.sessionID)
        },
      },
      {
        bind: "p",
        title: i18n.t("feature.storybook.command.promptSelectedTab"),
        group: i18n.t("feature.storybook.group"),
        run() {
          const current = active()
          if (!current) return
          prompt(current)
        },
      },
      {
        // Random runs may select any eligible tab; this command guarantees the edge flash
        // and running sweep can be watched under the cursor.
        bind: "s",
        title: i18n.t("feature.storybook.command.runSelectedTab"),
        group: i18n.t("feature.storybook.group"),
        run() {
          const current = active()
          if (!current) return
          if (controller.status(current).busy && !controller.status(current).attention) {
            setLastEvent(`tab ${number(current)} is already running`)
            return
          }
          startRun(current)
        },
      },
      ...(
        [
          { bind: "q", title: i18n.t("feature.storybook.command.askQuestion"), attention: "question" },
          { bind: "a", title: i18n.t("feature.storybook.command.requestPermission"), attention: "permission" },
          { bind: "i", title: i18n.t("feature.storybook.command.setIdle"), attention: false },
        ] as const
      ).map((state) => ({
        bind: state.bind,
        title: state.title,
        group: i18n.t("feature.storybook.group"),
        run() {
          const current = active()
          if (!current) return
          startRun(current)
          setStatuses((statuses) => ({
            ...statuses,
            [current]: { ...EMPTY_SESSION_TAB_STATUS, busy: Boolean(state.attention), attention: state.attention },
          }))
          setLastEvent(`tab ${number(current)} ${state.attention || "idle"}`)
        },
      })),
      ...(
        [
          { bind: "f", title: i18n.t("feature.storybook.command.completeSelectedTab"), failed: false },
          { bind: "x", title: i18n.t("feature.storybook.command.failSelectedTab"), failed: true },
        ] as const
      ).map((state) => ({
        bind: state.bind,
        title: state.title,
        group: i18n.t("feature.storybook.group"),
        run() {
          const current = active()
          if (!current) return
          // Leave the result unread so its indicator can be inspected before selecting it again.
          cycle(1)
          finishRun(current, state.failed)
        },
      })),
      {
        bind: "c",
        title: i18n.t("feature.storybook.command.cycleSpinner"),
        group: i18n.t("feature.storybook.group"),
        run: () => setSpinner((value) => spinners[(spinners.indexOf(value) + 1) % spinners.length]),
      },
      {
        bind: "u",
        title: i18n.t("feature.storybook.command.cycleUnreadMarker"),
        group: i18n.t("feature.storybook.group"),
        run: () => setMarker((value) => markers[(markers.indexOf(value) + 1) % markers.length]),
      },
      {
        bind: "m",
        title: i18n.t("feature.storybook.command.toggleAnimations"),
        group: i18n.t("feature.storybook.group"),
        run: () => setAnimations((value) => !value),
      },
      {
        bind: "t",
        title: i18n.t("feature.storybook.command.addTab"),
        group: i18n.t("feature.storybook.group"),
        run: addTab,
      },
      {
        bind: "d",
        title: i18n.t("feature.storybook.command.closeTab"),
        group: i18n.t("feature.storybook.group"),
        run: () => controller.close(),
      },
      {
        bind: "o",
        title: i18n.t("feature.storybook.command.toggleTabOrientation"),
        group: i18n.t("feature.storybook.group"),
        run() {
          setOrientation((value) => (value === "vertical" ? "horizontal" : "vertical"))
        },
      },
      {
        bind: "r,shift+r",
        title: i18n.t("feature.storybook.command.resetIdle"),
        group: i18n.t("feature.storybook.group"),
        run: () => reset(),
      },
      {
        bind: "v",
        title: i18n.t("feature.storybook.command.showAllStates"),
        group: i18n.t("feature.storybook.group"),
        run: () => reset(true),
      },
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background.default}
    >
      <box flexGrow={1} flexDirection={orientation() === "vertical" ? "row" : "column"}>
        <SessionTabs
          controller={controller}
          orientation={orientation()}
          spinner={spinner()}
          unreadMarker={marker()}
          animations={animations()}
        />
        <box flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1} flexDirection="column">
          <For each={transcript()}>
            {(line) => (
              <text fg={line.color} wrapMode="none" selectable={false}>
                {line.text || " "}
              </text>
            )}
          </For>
        </box>
      </box>
      <StoryFooter
        context={props.context}
        title={i18n.t("feature.storybook.footer.sessionTabs")}
        details={[
          orientation() === "vertical"
            ? i18n.t("feature.storybook.detail.leftRail")
            : i18n.t("feature.storybook.detail.topStrip"),
          spinner(),
          `${TAB_UNREAD_MARKERS[marker()]} ${marker()}`,
          animations() ? i18n.t("feature.storybook.detail.animated") : i18n.t("feature.storybook.detail.still"),
        ]}
        status={stateSummary()}
        message={lastEvent()}
        controls={[
          { shortcut: "s", label: i18n.t("feature.storybook.control.work") },
          { shortcut: "space/e", label: i18n.t("feature.storybook.control.randomWork") },
          { shortcut: "p", label: i18n.t("feature.storybook.control.prompt") },
          { shortcut: "q", label: i18n.t("feature.storybook.control.question") },
          { shortcut: "a", label: i18n.t("feature.storybook.control.permission") },
          { shortcut: "i", label: i18n.t("feature.storybook.control.idle") },
          { shortcut: "f/x", label: i18n.t("feature.storybook.control.completeFail") },
          { shortcut: "t/d", label: i18n.t("feature.storybook.control.addClose") },
          { shortcut: "c", label: i18n.t("feature.storybook.control.spinner") },
          { shortcut: "u", label: i18n.t("feature.storybook.control.unreadMarker") },
          { shortcut: "m", label: i18n.t("feature.storybook.control.motion") },
          { shortcut: "↑/↓", label: i18n.t("feature.storybook.control.select") },
          { shortcut: "o", label: i18n.t("feature.storybook.control.layout") },
          { shortcut: "r", label: i18n.t("feature.storybook.control.resetIdle") },
          { shortcut: "v", label: i18n.t("feature.storybook.control.allStates") },
          { shortcut: "esc", label: i18n.t("feature.storybook.control.back") },
        ]}
      />
    </box>
  )
}

export const sessionTabsStory: Story = {
  id: "session-tabs",
  title: "Tabs",
  render: (context) => <SessionTabsStory context={context} />,
}
