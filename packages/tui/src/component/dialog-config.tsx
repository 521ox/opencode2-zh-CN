import { createMemo, createSignal } from "solid-js"
import { useConfig } from "../config"
import { useThemes } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { useI18n } from "../context/i18n"
import type { Translator } from "../i18n"

type Setting = {
  title: string
  category: string
  path: string[]
  default: unknown
  values?: readonly unknown[]
  labels?: readonly string[]
  step?: number
  min?: number
  max?: number
  format?: (value: unknown) => string
  keywords?: readonly string[]
}

export const settings: Setting[] = [
  {
    title: "Language",
    category: "Appearance",
    path: ["locale"],
    default: "zh",
    values: ["zh", "en"],
    labels: ["Simplified Chinese", "English"],
    keywords: ["locale", "translation", "English", "Chinese"],
  },
  {
    title: "Theme",
    category: "Appearance",
    path: ["theme", "name"],
    default: "opencode",
    keywords: ["color scheme", "colors"],
  },
  {
    title: "Color mode",
    category: "Appearance",
    path: ["theme", "mode"],
    default: "system",
    values: ["system", "dark", "light"],
    keywords: ["dark mode", "light mode", "system theme"],
  },
  {
    title: "Animations",
    category: "Appearance",
    path: ["animations"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["motion", "effects"],
  },
  {
    title: "Sidebar",
    category: "Session",
    path: ["session", "sidebar"],
    default: "auto",
    values: ["hide", "auto"],
    keywords: ["side panel"],
  },
  {
    title: "Scrollbar",
    category: "Session",
    path: ["session", "scrollbar"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["scroll bar"],
  },
  {
    title: "Thinking",
    category: "Session",
    path: ["session", "thinking"],
    default: "hide",
    values: ["hide", "show"],
    keywords: ["reasoning", "chain of thought"],
  },
  {
    title: "Markdown",
    category: "Session",
    path: ["session", "markdown"],
    default: "rendered",
    values: ["source", "rendered"],
    keywords: ["syntax", "concealment", "rendering"],
  },
  {
    title: "Grouping",
    category: "Session",
    path: ["session", "grouping"],
    default: "auto",
    values: ["none", "auto"],
    keywords: ["transcript", "messages"],
  },
  {
    title: "Transcript images",
    category: "Session",
    path: ["session", "image_preview"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["attachments", "images", "tool output"],
  },
  {
    title: "New session location",
    category: "Session",
    path: ["session", "new_location"],
    default: "launch",
    values: ["launch", "inherit"],
    labels: ["launch directory", "active session"],
    keywords: ["directory", "cwd", "inherit"],
  },
  {
    title: "Enabled",
    category: "Tabs",
    path: ["tabs", "enabled"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
  },
  {
    title: "Scope",
    category: "Tabs",
    path: ["tabs", "scope"],
    default: "cwd",
    values: ["cwd", "global"],
    labels: ["current directory", "global"],
  },
  {
    title: "Layout",
    category: "Tabs",
    path: ["tabs", "layout"],
    default: "horizontal",
    values: ["horizontal", "vertical"],
    keywords: ["sidebar", "orientation", "left"],
  },
  {
    title: "Layout",
    category: "Diffs",
    path: ["diffs", "view"],
    default: "auto",
    values: ["auto", "split", "unified"],
    keywords: ["diff layout", "split diff", "unified diff"],
  },
  {
    title: "Wrapping",
    category: "Diffs",
    path: ["diffs", "wrap"],
    default: "word",
    values: ["none", "word"],
    keywords: ["diff wrap", "word wrap", "line wrap"],
  },
  {
    title: "File tree",
    category: "Diffs",
    path: ["diffs", "tree"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["diff files"],
  },
  {
    title: "Single patch",
    category: "Diffs",
    path: ["diffs", "single"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["one file", "selected file"],
  },
  {
    title: "Scroll speed",
    category: "Input",
    path: ["scroll", "speed"],
    default: 3,
    step: 0.25,
    min: 0.25,
    max: 10,
    format: (value) => Number(value).toFixed(2),
    keywords: ["scrolling"],
  },
  {
    title: "Acceleration",
    category: "Input",
    path: ["scroll", "acceleration"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["scroll acceleration"],
  },
  {
    title: "Mouse",
    category: "Input",
    path: ["mouse"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["mouse capture"],
  },
  {
    title: "Editor context",
    category: "Input",
    path: ["prompt", "editor"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["file context", "prompt context", "editor selection"],
  },
  {
    title: "Large pastes",
    category: "Input",
    path: ["prompt", "paste"],
    default: "compact",
    values: ["compact", "full"],
    keywords: ["paste summary", "clipboard", "pasted content"],
  },
  {
    title: "Image previews",
    category: "Input",
    path: ["prompt", "image_preview"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["attachments", "clipboard", "images", "prompt"],
  },
  {
    title: "Leader timeout",
    category: "Input",
    path: ["leader", "timeout"],
    default: 2000,
    step: 250,
    min: 250,
    max: 10000,
    format: (value) => `${value} ms`,
    keywords: ["leader key", "shortcut timeout"],
  },
  {
    title: "Attention",
    category: "Alerts",
    path: ["attention", "enabled"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["alerts"],
  },
  {
    title: "Notifications",
    category: "Alerts",
    path: ["attention", "notifications"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["system notifications", "desktop notifications", "alerts"],
  },
  {
    title: "Sounds",
    category: "Alerts",
    path: ["attention", "sound"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["audio", "sound effects"],
  },
  {
    title: "Volume",
    category: "Alerts",
    path: ["attention", "volume"],
    default: 0.4,
    step: 0.1,
    min: 0,
    max: 1,
    format: (value) => `${Math.round(Number(value) * 100)}%`,
    keywords: ["sound volume", "audio volume"],
  },
  {
    title: "Window title",
    category: "Terminal",
    path: ["terminal", "title"],
    default: true,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["terminal title", "tab title"],
  },
  {
    title: "Copy on select",
    category: "Terminal",
    path: ["terminal", "copy_on_select"],
    default: process.platform !== "win32",
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["selection", "clipboard"],
  },
  {
    title: "Developer tools",
    category: "Debug",
    path: ["debug", "devtools"],
    default: false,
    values: [false, true],
    labels: ["off", "on"],
    keywords: ["debug bar", "developer tools"],
  },
]

export function settingID(setting: Setting) {
  return setting.path.join(".")
}

export function localizeSettings(t: Translator): Setting[] {
  const titles: Record<string, string> = {
    locale: t("dialog.config.setting.language"),
    "theme.name": t("dialog.config.setting.themeName"),
    "theme.mode": t("dialog.config.setting.colorMode"),
    animations: t("dialog.config.setting.animations"),
    "session.sidebar": t("dialog.config.setting.sidebar"),
    "session.scrollbar": t("dialog.config.setting.scrollbar"),
    "session.thinking": t("dialog.config.setting.thinking"),
    "session.markdown": t("dialog.config.setting.markdown"),
    "session.grouping": t("dialog.config.setting.grouping"),
    "session.image_preview": t("dialog.config.setting.transcriptImages"),
    "session.new_location": t("dialog.config.setting.newSessionLocation"),
    "tabs.enabled": t("dialog.config.setting.tabsEnabled"),
    "tabs.scope": t("dialog.config.setting.tabsScope"),
    "tabs.layout": t("dialog.config.setting.tabsLayout"),
    "diffs.view": t("dialog.config.setting.diffsLayout"),
    "diffs.wrap": t("dialog.config.setting.diffsWrapping"),
    "diffs.tree": t("dialog.config.setting.diffsFileTree"),
    "diffs.single": t("dialog.config.setting.diffsSinglePatch"),
    "scroll.speed": t("dialog.config.setting.scrollSpeed"),
    "scroll.acceleration": t("dialog.config.setting.scrollAcceleration"),
    mouse: t("dialog.config.setting.mouse"),
    "prompt.editor": t("dialog.config.setting.editorContext"),
    "prompt.paste": t("dialog.config.setting.largePastes"),
    "prompt.image_preview": t("dialog.config.setting.imagePreviews"),
    "leader.timeout": t("dialog.config.setting.leaderTimeout"),
    "attention.enabled": t("dialog.config.setting.attention"),
    "attention.notifications": t("dialog.config.setting.notifications"),
    "attention.sound": t("dialog.config.setting.sounds"),
    "attention.volume": t("dialog.config.setting.volume"),
    "terminal.title": t("dialog.config.setting.windowTitle"),
    "terminal.copy_on_select": t("dialog.config.setting.copyOnSelect"),
    "debug.devtools": t("dialog.config.setting.developerTools"),
  }
  const categories: Record<string, string> = {
    Appearance: t("dialog.config.category.appearance"),
    Session: t("dialog.config.category.session"),
    Tabs: t("dialog.config.category.tabs"),
    Diffs: t("dialog.config.category.diffs"),
    Input: t("dialog.config.category.input"),
    Alerts: t("dialog.config.category.alerts"),
    Terminal: t("dialog.config.category.terminal"),
    Debug: t("dialog.config.category.debug"),
  }
  const labels: Record<string, string> = {
    off: t("dialog.config.value.off"),
    on: t("dialog.config.value.on"),
    "Simplified Chinese": t("dialog.config.value.simplifiedChinese"),
    English: t("dialog.config.value.english"),
    "launch directory": t("dialog.config.value.launchDirectory"),
    "active session": t("dialog.config.value.activeSession"),
    "current directory": t("dialog.config.value.currentDirectory"),
    global: t("dialog.config.value.global"),
  }
  return settings.map((setting) => ({
    ...setting,
    title: titles[settingID(setting)],
    category: categories[setting.category],
    labels: setting.labels?.map((label) => labels[label] ?? label),
  }))
}

export function DialogConfig(props: { current?: string }) {
  const config = useConfig()
  const toast = useToast()
  const themes = useThemes()
  const { t } = useI18n()
  const current = Math.max(
    0,
    settings.findIndex((setting) => settingID(setting) === props.current),
  )
  const [selected, setSelected] = createSignal(current)
  const [saving, setSaving] = createSignal(false)
  const localizedSettings = createMemo(() => localizeSettings(t))

  const value = (setting: Setting) => {
    const current = setting.path.reduce<unknown>((result, key) => {
      if (!result || typeof result !== "object") return undefined
      return (result as Record<string, unknown>)[key]
    }, config.data)
    if (setting.path.join(".") === "theme.name") return current ?? themes.selected
    return current ?? setting.default
  }
  const values = (setting: Setting) =>
    setting.path.join(".") === "theme.name"
      ? Object.keys(themes.all()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      : setting.values
  const display = (setting: Setting) => {
    const current = value(setting)
    if (setting.format) return setting.format(current)
    const index = setting.values?.indexOf(current)
    return index === undefined || index < 0 ? String(current) : (setting.labels?.[index] ?? String(current))
  }
  const options = createMemo(() =>
    localizedSettings().map((setting, index) => ({
      title: setting.title,
      category: setting.category,
      searchText: setting.keywords?.join(" "),
      footer: display(setting),
      value: index,
    })),
  )

  async function change(direction: number, index = selected()) {
    if (saving()) return
    const setting = settings[index]
    const current = value(setting)
    const choices = values(setting)
    const next = choices
      ? choices[(choices.indexOf(current) + direction + choices.length) % choices.length]
      : Math.min(setting.max!, Math.max(setting.min!, Number(current) + direction * setting.step!))
    if (next === current) return
    setSaving(true)
    await config
      .update((draft) => {
        const parent = setting.path.slice(0, -1).reduce<Record<string, unknown>>((result, key) => {
          if (!result[key] || typeof result[key] !== "object") result[key] = {}
          return result[key] as Record<string, unknown>
        }, draft)
        parent[setting.path.at(-1)!] = next
      })
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  return (
    <DialogSelect
      title={t("dialog.config.title")}
      options={options()}
      current={current}
      filterThreshold={0.7}
      onMove={(option) => setSelected(option.value)}
      onSelect={(option) => void change(1, option.value)}
      footerHints={[{ title: "←/→", label: t("dialog.config.change") }]}
      bindings={[
        {
          bind: "left",
          title: t("dialog.config.previousValue"),
          group: t("dialog.config.title"),
          run: () => void change(-1),
        },
        {
          bind: "right",
          title: t("dialog.config.nextValue"),
          group: t("dialog.config.title"),
          run: () => void change(1),
        },
      ]}
    />
  )
}
