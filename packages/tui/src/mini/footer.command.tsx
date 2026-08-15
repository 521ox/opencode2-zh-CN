/** @jsxImportSource @opentui/solid */
import { TextAttributes, type InputRenderable, type KeyEvent } from "@opentui/core"
import { useKeyboard, type JSX } from "@opentui/solid"
import fuzzysort from "fuzzysort"
import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { Keymap } from "../context/keymap"
import { useI18n } from "../context/i18n"
import { RunFooterMenu, createFooterMenuState, type RunFooterMenuItem } from "./footer.menu"
import { monoShortcut } from "./mono"
import type { RunFooterTheme } from "./theme"
import type {
  FooterQueuedPrompt,
  FooterSubagentTab,
  MiniSettingChange,
  MiniSettings,
  RunAgent,
  RunCommand,
  RunInput,
  RunProvider,
} from "./types"

type PanelEntry = RunFooterMenuItem & {
  category: string
  keywords?: string
}

type CommandEntry =
  | (PanelEntry & { action: "agent" })
  | (PanelEntry & { action: "model" })
  | (PanelEntry & { action: "editor" })
  | (PanelEntry & { action: "skill" })
  | (PanelEntry & { action: "queued" })
  | (PanelEntry & { action: "subagent" })
  | (PanelEntry & { action: "status" })
  | (PanelEntry & { action: "variant.cycle" })
  | (PanelEntry & { action: "variant.list" })
  | (PanelEntry & { action: "settings" })
  | (PanelEntry & { action: "slash"; name: string })
  | (PanelEntry & { action: "exit" })

type ModelEntry = PanelEntry & {
  providerID: string
  modelID: string
  providerName: string
  current: boolean
}

type AgentEntry = PanelEntry & {
  id: string
  current: boolean
}

type VariantEntry = PanelEntry & {
  variant: string | undefined
  current: boolean
}

type SkillEntry = PanelEntry & {
  name: string
}

type QueuedPromptEntry = PanelEntry & {
  prompt: FooterQueuedPrompt
}

type SubagentEntry = PanelEntry & {
  sessionID: string
  current: boolean
}

type SettingEntry = PanelEntry & {
  key: keyof MiniSettings
}

const PANEL_PAD = 2
const panelPad = (mono?: boolean) => (mono ? 1 : PANEL_PAD)
const PANEL_LIST_ROWS = 10
const PANEL_FRAME_ROWS = 6
export const RUN_COMMAND_PANEL_ROWS = PANEL_LIST_ROWS + PANEL_FRAME_ROWS
const SUBAGENT_LIST_ROWS = 12
export const RUN_SUBAGENT_PANEL_ROWS = SUBAGENT_LIST_ROWS + PANEL_FRAME_ROWS
const PANEL_PAGE = PANEL_LIST_ROWS - 1
const HALF_BLOCK_BORDER = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: "▀",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

function countLabel(count: number, total: number, query: string) {
  if (!query.trim()) {
    return `${total}`
  }

  return `${count}/${total}`
}

function subagentStatusLabel(status: FooterSubagentTab["status"], t: ReturnType<typeof useI18n>["t"]) {
  if (status === "completed") {
    return t("mini.command.done")
  }

  if (status === "cancelled") {
    return t("mini.command.cancelled")
  }

  if (status === "error") {
    return t("mini.command.error")
  }

  return t("mini.command.running")
}

function match<T extends PanelEntry>(query: string, entries: T[]) {
  const text = query.trim()
  if (!text) {
    return entries
  }

  return fuzzysort
    .go(text, entries, { keys: ["display", "category", "description", "keywords"] })
    .map((item) => item.obj)
}

function createSearchablePanelController<T extends PanelEntry>(input: {
  entries: Accessor<T[]>
  limit: number
  onClose: () => void
  onSelect: (item: T) => void
  isCurrent?: (item: T) => boolean
  closeOnFirstUp?: boolean
  onKey?: (event: KeyEvent, item: T | undefined) => boolean
  onRows?: (rows: number) => void
}) {
  let field: InputRenderable | undefined
  const [query, setQuery] = createSignal("")
  const items = createMemo<T[]>(() => match(query(), input.entries()))
  const menu = createFooterMenuState({ count: () => items().length, limit: input.limit })
  const selected = () => items()[menu.selected()]

  createEffect(() => {
    query()
    menu.reset()
  })

  createEffect(() => {
    if (!input.isCurrent || query().trim()) {
      return
    }

    const index = items().findIndex(input.isCurrent)
    if (index !== -1) {
      menu.reveal(index)
    }
  })

  createEffect(() => {
    input.onRows?.(menu.rows() + PANEL_FRAME_ROWS)
  })

  useKeyboard((event) => {
    if (event.defaultPrevented) {
      return
    }

    if (input.onKey?.(event, selected())) {
      return
    }

    const name = event.name.toLowerCase()
    if (input.closeOnFirstUp && name === "up" && menu.selected() === 0) {
      event.preventDefault()
      input.onClose()
      return
    }

    const ctrl = event.ctrl && !event.meta && !event.shift && !event.super
    if (name === "escape" || (ctrl && name === "c")) {
      event.preventDefault()
      input.onClose()
      return
    }

    if (name === "up" || (ctrl && name === "p")) {
      event.preventDefault()
      menu.move(-1)
      return
    }

    if (name === "down" || (ctrl && name === "n")) {
      event.preventDefault()
      menu.move(1)
      return
    }

    if (name === "pageup") {
      event.preventDefault()
      menu.reveal(menu.selected() - PANEL_PAGE)
      return
    }

    if (name === "pagedown") {
      event.preventDefault()
      menu.reveal(menu.selected() + PANEL_PAGE)
      return
    }

    if (name === "home") {
      event.preventDefault()
      menu.reveal(0)
      return
    }

    if (name === "end") {
      event.preventDefault()
      menu.reveal(Number.POSITIVE_INFINITY)
      return
    }

    if (name === "return") {
      event.preventDefault()
      const item = selected()
      if (item) {
        input.onSelect(item)
      }
      return
    }

    if (ctrl && name === "u") {
      event.preventDefault()
      setQuery("")
      field?.setText("")
    }
  })

  return {
    query,
    setQuery,
    items,
    menu,
    inputRef(input: InputRenderable) {
      field = input
    },
  }
}

function PanelShell(props: {
  title: string
  countVisible?: boolean
  query: string
  count: number
  total: number
  placeholder: string
  theme: Accessor<RunFooterTheme>
  inputRef: (input: InputRenderable) => void
  onQuery: (query: string) => void
  children: JSX.Element
  hint?: string
  mono?: boolean
}) {
  const background = () => props.theme().shade
  const content = (
    <>
      <box height={1} flexShrink={0} backgroundColor={background()} />
      <box
        width="100%"
        height={1}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        flexDirection="row"
        gap={1}
        flexShrink={0}
        backgroundColor={background()}
      >
        <text fg={props.theme().text} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
          {props.title}
        </text>
        {props.countVisible !== false ? (
          <text fg={props.theme().muted} wrapMode="none" flexShrink={0}>
            {countLabel(props.count, props.total, props.query)}
          </text>
        ) : null}
        <box flexGrow={1} flexShrink={1} backgroundColor="transparent" />
        <text fg={props.theme().muted} wrapMode="none" truncate flexShrink={0}>
          {props.hint ? `${props.hint} ${props.mono ? "-" : "·"} ` : ""}esc
        </text>
      </box>
      <box height={1} flexShrink={0} backgroundColor={background()} />
      <box
        width="100%"
        height={1}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        flexShrink={0}
        backgroundColor={background()}
      >
        <input
          width="100%"
          focusedBackgroundColor={background()}
          focusedTextColor={props.theme().text}
          placeholder={props.placeholder}
          placeholderColor={props.theme().muted}
          cursorColor={props.theme().highlight}
          onInput={props.onQuery}
          ref={(input) => {
            props.inputRef(input)
            input.traits = { status: "FILTER" }
            queueMicrotask(() => {
              if (!input.isDestroyed) {
                input.focus()
              }
            })
          }}
        />
      </box>
      <box height={1} flexShrink={0} backgroundColor={background()} />
      <box width="100%" flexDirection="column" flexShrink={0} backgroundColor={background()}>
        {props.children}
      </box>
    </>
  )
  return (
    <box width="100%" flexDirection="column" border={false} backgroundColor="transparent" flexShrink={0}>
      <box width="100%" flexDirection="column" border={false} backgroundColor="transparent" flexShrink={0}>
        {content}
      </box>
      <box width="100%" height={1} border={false} backgroundColor="transparent" flexShrink={0}>
        {props.mono ? null : (
          <box
            width="100%"
            height={1}
            border={["bottom"]}
            borderColor={background()}
            backgroundColor="transparent"
            customBorderChars={HALF_BLOCK_BORDER}
          />
        )}
      </box>
    </box>
  )
}

export function RunCommandMenuBody(props: {
  theme: Accessor<RunFooterTheme>
  commands: Accessor<RunCommand[] | undefined>
  subagents: Accessor<FooterSubagentTab[]>
  queued: Accessor<FooterQueuedPrompt[]>
  variants: Accessor<string[]>
  variantCycle: string
  onClose: () => void
  onAgent: () => void
  onModel: () => void
  onEditor: () => void
  onSkill: () => void
  onSubagent: () => void
  onQueued: () => void
  onVariant: () => void
  onVariantCycle: () => void
  onStatus: () => void
  onSettings: () => void
  onCommand: (name: string) => void
  onNew: () => void
  onExit: () => void
  mono?: boolean
}) {
  const { t } = useI18n()
  const skills = createMemo(() => (props.commands() ?? []).filter((item) => item.source === "skill"))
  const activeSubagentCount = createMemo(() => props.subagents().filter((item) => item.status === "running").length)
  const entries = createMemo<CommandEntry[]>(() => {
    const session: CommandEntry[] = [
      {
        action: "editor",
        category: t("mini.command.category.session"),
        display: t("mini.command.openEditor"),
        footer: "/editor",
        keywords: "editor compose draft external editor",
      },
      {
        action: "status",
        category: t("mini.command.category.session"),
        display: t("mini.command.showStatus"),
        keywords: "status activity model context usage footer",
      },
      ...(props.subagents().length > 0
        ? [
            {
              action: "subagent" as const,
              category: t("mini.command.category.session"),
              display: t("mini.command.viewSubagents"),
              footer:
                activeSubagentCount() > 0
                  ? t("mini.command.active", { count: activeSubagentCount() })
                  : t("mini.command.recent", { count: props.subagents().length }),
              keywords: props
                .subagents()
                .map((item) => `${item.label} ${item.description} ${item.title ?? ""}`)
                .join(" "),
            },
          ]
        : []),
      {
        action: "slash",
        category: t("mini.command.category.session"),
        name: "compact",
        display: t("mini.command.compactSession"),
        footer: "/compact",
        keywords: "compact session context",
      },
      {
        action: "slash",
        category: t("mini.command.category.session"),
        name: "new",
        display: t("mini.command.newSession"),
        footer: "/new",
        keywords: "new session clear",
      },
    ]
    const prompt: CommandEntry[] =
      props.commands() === undefined || skills().length > 0
        ? [
            {
              action: "skill" as const,
              category: t("mini.command.category.prompt"),
              display: t("mini.command.skills"),
              footer: "/skills",
              keywords: `skill skills ${skills()
                .map((item) => `${item.name} ${item.description ?? ""}`)
                .join(" ")}`.trim(),
            },
          ]
        : []
    const agent: CommandEntry[] = [
      {
        action: "agent",
        category: t("mini.command.category.agent"),
        display: t("mini.command.switchAgent"),
      },
      {
        action: "model",
        category: t("mini.command.category.agent"),
        display: t("mini.command.switchModel"),
      },
      ...(props.queued().length > 0
        ? [
            {
              action: "queued" as const,
              category: t("mini.command.category.agent"),
              display: t("mini.command.viewQueuedPrompts"),
              footer: t("mini.command.pending", { count: props.queued().length }),
              keywords: props
                .queued()
                .map((item) => item.prompt.text)
                .join(" "),
            },
          ]
        : []),
      {
        action: "variant.cycle",
        category: t("mini.command.category.agent"),
        display: t("mini.command.variantCycle"),
        footer: props.variantCycle,
        keywords: "variant cycle",
      },
      ...(props.variants().length > 0
        ? [
            {
              action: "variant.list" as const,
              category: t("mini.command.category.agent"),
              display: t("mini.command.switchVariant"),
              keywords: `variant variants ${props.variants().join(" ")}`,
            },
          ]
        : []),
    ]
    return [
      ...session,
      ...prompt,
      ...agent,
      {
        action: "settings",
        category: t("mini.command.category.system"),
        display: t("mini.command.settings"),
        footer: "/settings",
        keywords: "/settings settings preferences configuration",
      },
      {
        action: "exit",
        category: t("mini.command.category.system"),
        display: t("mini.command.exit"),
        footer: "/exit",
        keywords: "/exit exit",
      },
    ]
  })
  const pick = (item: CommandEntry) => {
    if (item.action === "agent") {
      props.onAgent()
      return
    }

    if (item.action === "model") {
      props.onModel()
      return
    }

    if (item.action === "editor") {
      props.onEditor()
      return
    }

    if (item.action === "skill") {
      props.onSkill()
      return
    }

    if (item.action === "subagent") {
      props.onSubagent()
      return
    }

    if (item.action === "queued") {
      props.onQueued()
      return
    }

    if (item.action === "variant.cycle") {
      props.onVariantCycle()
      return
    }

    if (item.action === "variant.list") {
      props.onVariant()
      return
    }

    if (item.action === "status") {
      props.onStatus()
      return
    }

    if (item.action === "settings") {
      props.onSettings()
      return
    }

    if (item.action === "exit") {
      props.onExit()
      return
    }

    if (item.name === "new") {
      props.onNew()
      return
    }

    props.onCommand(item.name)
  }
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: pick,
  })

  return (
    <PanelShell
      title={t("mini.command.commands")}
      countVisible={false}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder={t("mini.command.search")}
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={() => PANEL_LIST_ROWS}
        limit={PANEL_LIST_ROWS}
        empty={t("mini.command.noResults")}
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={!controller.query().trim()}
        background
        headerColor={props.theme().muted}
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunAgentSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  agents: Accessor<RunAgent[]>
  current: Accessor<string | undefined>
  onClose: () => void
  onSelect: (agent: string) => void
  mono?: boolean
}) {
  const { t } = useI18n()
  const entries = createMemo<AgentEntry[]>(() =>
    props
      .agents()
      .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
      .map((agent) => ({
        category: "",
        display: agent.id,
        description: agent.description,
        footer: props.current() === agent.id ? t("mini.command.current") : undefined,
        keywords: `${agent.id} ${agent.name} ${agent.description ?? ""}`,
        id: agent.id,
        current: props.current() === agent.id,
      })),
  )
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSelect(item.id),
    isCurrent: (item) => item.current,
  })

  return (
    <PanelShell
      title={t("mini.command.selectAgent")}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder={t("mini.command.search")}
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={() => PANEL_LIST_ROWS}
        limit={PANEL_LIST_ROWS}
        empty={t("mini.command.noAgents")}
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={false}
        background
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunSettingsBody(props: {
  theme: Accessor<RunFooterTheme>
  settings: Accessor<MiniSettings>
  onClose: () => void
  onChange: (change: MiniSettingChange) => void | Promise<void>
  mono?: boolean
}) {
  const { t } = useI18n()
  const [saving, setSaving] = createSignal<keyof MiniSettings>()
  const entries = createMemo<SettingEntry[]>(() => [
    {
      category: t("mini.command.category.transcript"),
      display: t("mini.command.setting.thinking"),
      footer: saving() === "thinking" ? t("mini.command.setting.saving") : props.settings().thinking,
      keywords: `thinking reasoning ${props.settings().thinking}`,
      key: "thinking",
    },
    {
      category: t("mini.command.category.transcript"),
      display: t("mini.command.setting.shell"),
      footer: saving() === "shell_output" ? t("mini.command.setting.saving") : props.settings().shell_output,
      keywords: `shell tool command output ${props.settings().shell_output}`,
      key: "shell_output",
    },
    {
      category: t("mini.command.category.transcript"),
      display: t("mini.command.setting.turnSummary"),
      footer: saving() === "turn_summary" ? t("mini.command.setting.saving") : props.settings().turn_summary,
      keywords: `turn summary agent model duration ${props.settings().turn_summary}`,
      key: "turn_summary",
    },
    {
      category: t("mini.command.category.terminal"),
      display: t("mini.command.setting.footer"),
      footer: saving() === "footer" ? t("mini.command.setting.saving") : props.settings().footer,
      keywords: `footer status activity model context usage ${props.settings().footer}`,
      key: "footer",
    },
    {
      category: t("mini.command.category.terminal"),
      display: t("mini.command.setting.splash"),
      footer: saving() === "splash" ? t("mini.command.setting.saving") : props.settings().splash,
      keywords: `splash entry exit banner ${props.settings().splash}`,
      key: "splash",
    },
    {
      category: t("mini.command.category.terminal"),
      display: t("mini.command.setting.monochrome"),
      footer: saving() === "mono" ? t("mini.command.setting.saving") : props.settings().mono ? t("mini.command.setting.on") : t("mini.command.setting.off"),
      keywords: `mono monochrome ascii legacy compat terminal ${props.settings().mono ? "on" : "off"}`,
      key: "mono",
    },
  ])
  const change = (item: SettingEntry) => {
    if (saving()) return
    const next: MiniSettingChange =
      item.key === "mono"
        ? { key: "mono", value: !props.settings().mono }
        : { key: item.key, value: props.settings()[item.key] === "show" ? "hide" : "show" }
    setSaving(item.key)
    void Promise.resolve(props.onChange(next))
      .catch(() => {})
      .finally(() => setSaving())
  }
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: change,
    onKey(event, item) {
      const name = event.name.toLowerCase()
      if (name !== "left" && name !== "right") return false
      event.preventDefault()
      if (item) change(item)
      return true
    },
  })

  return (
    <PanelShell
      title={t("mini.command.settingsTitle")}
      countVisible={false}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder={t("mini.command.search")}
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      hint={t("mini.command.hint.change")}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={() => PANEL_LIST_ROWS}
        limit={PANEL_LIST_ROWS}
        empty={t("mini.command.noSettings")}
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={!controller.query().trim()}
        background
        headerColor={props.theme().muted}
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunSubagentSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  tabs: Accessor<FooterSubagentTab[]>
  current: Accessor<string | undefined>
  onClose: () => void
  onSelect: (sessionID: string) => void
  onRows?: (rows: number) => void
  mono?: boolean
}) {
  const { t } = useI18n()
  const [active, setActive] = createSignal(true)
  const entries = createMemo<SubagentEntry[]>(() =>
    props
      .tabs()
      .filter((item) => (active() ? item.status === "running" : item.status !== "running"))
      .map((item) => {
        const title = item.description || item.title || item.label
        return {
          category: "",
          display: title,
          description: title === item.label ? undefined : item.label,
          footer: subagentStatusLabel(item.status, t),
          keywords: `${item.label} ${item.description} ${item.title ?? ""} ${item.status}`,
          sessionID: item.sessionID,
          current: props.current() === item.sessionID,
        }
      }),
  )
  const controller = createSearchablePanelController({
    entries,
    limit: SUBAGENT_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSelect(item.sessionID),
    isCurrent: (item) => item.current,
    closeOnFirstUp: true,
    onKey(event) {
      if (event.name.toLowerCase() !== "tab") return false
      event.preventDefault()
      setActive((value) => !value)
      return true
    },
    onRows: props.onRows,
  })

  return (
    <PanelShell
      title={t("mini.command.selectSubagent")}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder={t("mini.command.search")}
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      hint={t("mini.command.hint.show", { status: active() ? "inactive" : "active" })}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={controller.menu.rows}
        limit={SUBAGENT_LIST_ROWS}
        empty={t("mini.command.noSubagents")}
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={false}
        background
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunQueuedPromptSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  prompts: Accessor<FooterQueuedPrompt[]>
  onClose: () => void
  onSteer: (prompt: FooterQueuedPrompt) => void
  onDelete: (prompt: FooterQueuedPrompt) => void
  onRows?: (rows: number) => void
  mono?: boolean
}) {
  const { t } = useI18n()
  const entries = createMemo<QueuedPromptEntry[]>(() =>
    props.prompts().map((prompt) => ({
      category: "",
      display: prompt.prompt.text.replaceAll("\n", " "),
      footer: t("mini.footer.status.queued", { count: 1 }),
      keywords: prompt.prompt.text,
      prompt,
    })),
  )
  const controller = createSearchablePanelController({
    entries,
    limit: SUBAGENT_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSteer(item.prompt),
    onRows: props.onRows,
  })
  const shortcuts = Keymap.useShortcuts()
  const deleteShortcut = () => monoShortcut(shortcuts.get("queued_prompt.delete") ?? "", props.mono ?? false)
  Keymap.createLayer(() => ({
    priority: 1,
    commands: [
      {
        id: "queued_prompt.delete",
        title: t("mini.command.keymap.deleteQueued"),
        group: t("mini.footer.group.prompt"),
        run() {
          const item = controller.items()[controller.menu.selected()]
          if (!item) return false
          props.onDelete(item.prompt)
        },
      },
    ],
  }))

  return (
    <PanelShell
      title={t("mini.command.queuedPrompts")}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder={t("mini.command.search")}
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      hint={[
        t("mini.command.hint.steer"),
        deleteShortcut() ? t("mini.command.hint.delete", { shortcut: deleteShortcut() }) : undefined,
      ]
        .filter(Boolean)
        .join(" · ")}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={controller.menu.rows}
        limit={SUBAGENT_LIST_ROWS}
        empty={t("mini.command.noQueuedPrompts")}
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={false}
        background
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunSkillSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  commands: Accessor<RunCommand[] | undefined>
  onClose: () => void
  onSelect: (name: string) => void
  mono?: boolean
}) {
  const { t } = useI18n()
  const entries = createMemo<SkillEntry[]>(() =>
    (props.commands() ?? [])
      .filter((item) => item.source === "skill")
      .map((item) => ({
        category: "",
        display: item.name,
        description: item.description?.replace(/\s+/g, " ").trim() || undefined,
        keywords: `skill ${item.name} ${item.description ?? ""}`,
        name: item.name,
      }))
      .sort((a, b) => a.display.localeCompare(b.display)),
  )
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSelect(item.name),
  })

  return (
    <PanelShell
      title={t("mini.command.skillsTitle")}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder={t("mini.command.search")}
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={() => PANEL_LIST_ROWS}
        limit={PANEL_LIST_ROWS}
        empty={props.commands() ? t("mini.command.noSkills") : t("mini.command.skillsLoading")}
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={false}
        background
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunVariantSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  variants: Accessor<string[]>
  current: Accessor<string | undefined>
  onClose: () => void
  onSelect: (variant: string | undefined) => void
  mono?: boolean
}) {
  const { t } = useI18n()
  const entries = createMemo<VariantEntry[]>(() => [
    {
      category: "",
      display: t("mini.command.variant.default"),
      description: props.current() === undefined ? t("mini.command.current") : undefined,
      keywords: "default",
      variant: undefined,
      current: props.current() === undefined,
    },
    ...props.variants().map((variant) => ({
      category: "",
      display: variant,
      description: props.current() === variant ? t("mini.command.current") : undefined,
      keywords: variant,
      variant,
      current: props.current() === variant,
    })),
  ])
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSelect(item.variant),
    isCurrent: (item) => item.current,
  })

  return (
    <PanelShell
      title={t("mini.command.selectVariant")}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder={t("mini.command.search")}
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={controller.items}
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={() => PANEL_LIST_ROWS}
        limit={PANEL_LIST_ROWS}
        empty={t("mini.command.noResults")}
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={false}
        background
        mono={props.mono}
      />
    </PanelShell>
  )
}

export function RunModelSelectBody(props: {
  theme: Accessor<RunFooterTheme>
  providers: Accessor<RunProvider[] | undefined>
  current: Accessor<RunInput["model"]>
  onClose: () => void
  onSelect: (model: NonNullable<RunInput["model"]>) => void
  mono?: boolean
}) {
  const { t } = useI18n()
  const entries = createMemo<ModelEntry[]>(() =>
    (props.providers() ?? [])
      .flatMap((provider) =>
        Object.entries(provider.models)
          .filter(([, model]) => model.status !== "deprecated")
          .map(([modelID, model]) => {
            const title = model.name ?? modelID
            const current = props.current()?.providerID === provider.id && props.current()?.modelID === modelID
            const footer = current
                ? t("mini.command.current")
              : model.cost?.input === 0 && provider.id === "opencode"
                ? t("mini.command.free")
                : title !== modelID
                  ? modelID
                  : undefined
            return {
              providerID: provider.id,
              modelID,
              providerName: provider.name,
              category: provider.name,
              display: title,
              footer,
              keywords: `${provider.id} ${provider.name} ${modelID} ${title} ${footer ?? ""}`,
              current,
            }
          }),
      )
      .sort((a, b) => {
        const provider = Number(a.providerID !== "opencode") - Number(b.providerID !== "opencode")
        if (provider !== 0) {
          return provider
        }

        const name = a.providerName.localeCompare(b.providerName)
        if (name !== 0) {
          return name
        }

        return a.display.localeCompare(b.display)
      }),
  )
  const controller = createSearchablePanelController({
    entries,
    limit: PANEL_LIST_ROWS,
    onClose: props.onClose,
    onSelect: (item) => props.onSelect({ providerID: item.providerID, modelID: item.modelID }),
    isCurrent: (item) => item.current,
  })

  return (
    <PanelShell
      title={t("mini.command.selectModel")}
      query={controller.query()}
      count={controller.items().length}
      total={entries().length}
      placeholder={t("mini.command.search")}
      theme={props.theme}
      inputRef={controller.inputRef}
      onQuery={controller.setQuery}
      mono={props.mono}
    >
      <RunFooterMenu
        theme={props.theme}
        items={() =>
          controller.query().trim()
            ? controller.items().map((item) => ({ ...item, footer: item.providerName }))
            : controller.items()
        }
        selected={controller.menu.selected}
        offset={controller.menu.offset}
        rows={() => PANEL_LIST_ROWS}
        limit={PANEL_LIST_ROWS}
        empty={props.providers() ? t("mini.command.noResults") : t("mini.command.modelsLoading")}
        border={false}
        paddingLeft={panelPad(props.mono)}
        paddingRight={panelPad(props.mono)}
        grouped={!controller.query().trim()}
        background
        headerColor={props.theme().muted}
        mono={props.mono}
      />
    </PanelShell>
  )
}
