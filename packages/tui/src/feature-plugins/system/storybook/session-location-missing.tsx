import type { Plugin } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { createSignal } from "solid-js"
import { useI18n } from "../../../context/i18n"
import { DialogMoveSession } from "../../../component/dialog-move-session"
import { SessionLocationUnavailable } from "../../../routes/session/location-missing"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

const directory = "/Users/kit/code/open-source/opencode-workerd-profile"

function SessionLocationMissingStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme.contextual.elevated
  const i18n = useI18n()
  const [message, setMessage] = createSignal(i18n.t("session.location.chooseDirectory"))
  const open = () =>
    props.context.ui.dialog.show(() => (
      <DialogMoveSession
        projectID="fixture-project"
        initialDirectories={[
          { directory: "/Users/kit/code/open-source/opencode" },
          {
            directory: "/Users/kit/code/open-source/opencode-instruction-rename",
            strategy: "git_worktree",
          },
        ]}
        fixture
        onSelect={(selection) => {
          if (selection.type !== "directory") return
          setMessage(i18n.t("feature.storybook.location.selectedDirectory", { directory: selection.directory }))
          props.context.ui.dialog.clear()
        }}
      />
    ))

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: i18n.t("feature.storybook.command.backToStorybook"),
        group: i18n.t("feature.storybook.group"),
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.default}>
      <box paddingLeft={2} paddingRight={2} paddingTop={1} flexGrow={1}>
        <text fg={theme.text.default} attributes={TextAttributes.BOLD}>
          Workerd Modal workspace driver
        </text>
        <text fg={theme.text.subdued}>build · GPT-5.6 Sol (high)</text>
        <box height={1} />
        <text fg={theme.text.default}>You</text>
        <text fg={theme.text.subdued}>Test the mounted workspace and verify the deployment.</text>
        <box height={1} />
        <text fg={theme.text.default}>Build · GPT-5.6 Sol (high)</text>
        <text fg={theme.text.subdued}>The deployment is verified and the worktree is clean.</text>
        <box flexGrow={1} />
        <SessionLocationUnavailable directory={directory} onMove={open} />
      </box>
      <StoryFooter
        context={props.context}
        title={i18n.t("feature.storybook.footer.sessionLocationMissing")}
        status={message()}
        controls={[
          { shortcut: "enter", label: i18n.t("feature.storybook.control.confirm") },
          { shortcut: "esc", label: i18n.t("feature.storybook.control.back") },
        ]}
      />
    </box>
  )
}

export const sessionLocationMissingStory: Story = {
  id: "session-location-missing",
  title: "Missing session directory",
  render: (context) => <SessionLocationMissingStory context={context} />,
}
