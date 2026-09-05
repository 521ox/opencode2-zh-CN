import { Plugin } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, type JSX } from "solid-js"
import { useI18n } from "../../../context/i18n"
import type { Translator } from "../../../i18n"
import { StoryFooter } from "./footer"
import { mermanLayoutsStory } from "./merman-layouts"
import { sessionTabsStory } from "./session-tabs"
import { sessionLocationMissingStory } from "./session-location-missing"

/**
 * A story is a full-screen, fixture-driven simulation of a real production component. Stories own
 * their entire screen (including any footer) and should bind escape back to the storybook index.
 */
export type Story = {
  id: string
  title: string
  render: (context: Plugin.Context) => JSX.Element
}

const stories: Story[] = [mermanLayoutsStory, sessionTabsStory, sessionLocationMissingStory]

export function storyTitle(story: Story, t: Translator) {
  if (story.id === "merman-layouts") return t("feature.storybook.story.mermanLayouts")
  if (story.id === "session-tabs") return t("feature.storybook.story.sessionTabs")
  if (story.id === "session-location-missing") return t("feature.storybook.story.sessionLocationMissing")
  return story.title
}

function Commands(props: { context: Plugin.Context }) {
  const i18n = useI18n()
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "app.storybook",
        title: i18n.t("feature.storybook.command.open"),
        group: i18n.t("feature.storybook.debugGroup"),
        palette: true,
        run() {
          props.context.ui.router.navigate({ type: "plugin", name: "storybook" })
          props.context.ui.dialog.clear()
        },
      },
      ...stories.map((story) => ({
        id: `app.storybook.${story.id}`,
        title: i18n.t("feature.storybook.command.openStory", { title: storyTitle(story, i18n.t) }),
        group: i18n.t("feature.storybook.debugGroup"),
        palette: true as const,
        run() {
          props.context.ui.router.navigate({ type: "plugin", name: "storybook", data: { story: story.id } })
          props.context.ui.dialog.clear()
        },
      })),
    ],
  }))
  return null
}

function StorybookIndex(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const i18n = useI18n()
  const [selected, setSelected] = createSignal(0)
  const open = (story: Story) =>
    props.context.ui.router.navigate({ type: "plugin", name: "storybook", data: { story: story.id } })

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: i18n.t("feature.storybook.command.backHome"),
        group: i18n.t("feature.storybook.group"),
        run() {
          props.context.ui.router.navigate({ type: "home" })
        },
      },
      {
        bind: "up,k",
        title: i18n.t("feature.storybook.command.previousStory"),
        group: i18n.t("feature.storybook.group"),
        run: () => setSelected((current) => (current + stories.length - 1) % stories.length),
      },
      {
        bind: "down,j",
        title: i18n.t("feature.storybook.command.nextStory"),
        group: i18n.t("feature.storybook.group"),
        run: () => setSelected((current) => (current + 1) % stories.length),
      },
      {
        bind: "return",
        title: i18n.t("feature.storybook.command.open"),
        group: i18n.t("feature.storybook.group"),
        run: () => open(stories[selected()]),
      },
      ...stories.map((story, index) => ({
        bind: String(index + 1),
        title: i18n.t("feature.storybook.command.openStory", { title: storyTitle(story, i18n.t) }),
        group: i18n.t("feature.storybook.group"),
        run: () => open(story),
      })),
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background.default}
    >
      <box paddingTop={2} paddingLeft={2} flexDirection="column">
        <text fg={theme.text.default}>{i18n.t("feature.storybook.title")}</text>
        <text fg={theme.text.subdued}>{i18n.t("feature.storybook.description")}</text>
        <box height={1} />
        <For each={stories}>
          {(story, index) => (
            <text fg={index() === selected() ? theme.text.default : theme.text.subdued}>
              {index() === selected() ? "› " : "  "}
              {index() + 1} {storyTitle(story, i18n.t)}
            </text>
          )}
        </For>
      </box>
      <box flexGrow={1} />
      <StoryFooter
        context={props.context}
        title={i18n.t("feature.storybook.title")}
        controls={[
          { shortcut: "↑/↓", label: i18n.t("feature.storybook.control.select") },
          { shortcut: "enter", label: i18n.t("feature.storybook.control.open") },
          { shortcut: "esc", label: i18n.t("feature.storybook.control.home") },
        ]}
      />
    </box>
  )
}

export default Plugin.define({
  id: "opencode.storybook",
  setup(context) {
    context.ui.router.register({
      name: "storybook",
      render: (input) => {
        const story = stories.find((story) => story.id === input.data?.story)
        if (story) return story.render(context)
        return <StorybookIndex context={context} />
      },
    })
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
