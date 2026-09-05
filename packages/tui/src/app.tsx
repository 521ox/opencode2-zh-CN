import { render, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { registerOpencodeSpinner } from "./component/register-spinner"
import { Effect, Latch } from "effect"
import { Service, type Endpoint } from "@opencode-ai/client/effect/service"
import { OpenCode, type SessionInfo } from "@opencode-ai/client"
import { Global } from "@opencode-ai/util/global"
import { ClipboardProvider, useClipboard } from "./context/clipboard"
import { LogProvider, useLog, type LogSink } from "./context/log"
import { ExitProvider, useExit } from "./context/exit"
import { EpilogueProvider } from "./context/epilogue"
import { Selection } from "./util/selection"
import {
  CliRenderEvents,
  createCliRenderer,
  MouseButton,
  type CliRenderer,
  type CliRendererConfig,
  type MouseEvent,
  type ThemeMode,
} from "@opentui/core"
import { RouteProvider, useRoute } from "./context/route"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
} from "solid-js"
import {
  TuiLifecycleProvider,
  TuiAppProvider,
  TuiPathsProvider,
  TuiStartupProvider,
  TuiTerminalEnvironmentProvider,
  useTuiApp,
  useTuiStartup,
  useTuiTerminalEnvironment,
  type TuiApp,
} from "./context/runtime"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogIntegration } from "./component/dialog-integration"
import { ErrorComponent } from "./component/error-component"
import { PluginRouteMissing } from "./component/plugin-route-missing"
import { EditorContextProvider } from "./context/editor"
import { useEvent } from "./context/event"
import { ClientProvider, useClient } from "./context/client"
import { StartupLoading } from "./component/startup-loading"
import { DevToolsBar } from "./component/devtools-bar"
import { Reconnecting } from "./component/reconnecting"
import { MigrationOverlay } from "./component/migration-overlay"
import { DataProvider, useData } from "./context/data"
import { SessionTabsProvider, useSessionTabs } from "./context/session-tabs"
import { LocationProvider, useLocation } from "./context/location"
import { LocalProvider, useLocal } from "./context/local"
import { PermissionProvider } from "./context/permission"
import { DialogModel } from "./component/dialog-model"
import { useConnected } from "./component/use-connected"
import { DialogMcp } from "./component/dialog-mcp"
import { DialogStatus } from "./component/dialog-status"
import { DialogConfig } from "./component/dialog-config"
import { DialogDebug } from "./component/dialog-debug"
import { DialogPair, type DialogPairCredentials } from "./component/dialog-pair"
import { DialogUpdate } from "./component/dialog-update"
import { DialogThemeList } from "./component/dialog-theme-list"
import { DialogHelp } from "./ui/dialog-help"
import { DialogAgent } from "./component/dialog-agent"
import { DialogSessionList } from "./component/dialog-session-list"
import { DialogOpen, DialogOpenKey, loadDialogOpen } from "./component/dialog-open"
import { SessionTabs } from "./component/session-tabs"
import { clampSessionTabsWidth, sessionTabsFitVertically, SESSION_SIDEBAR_WIDTH } from "./ui/layout"
import { ThemeErrorToast } from "./component/theme-error-toast"
import { createThemeSource, ThemeProvider, useTheme, useThemes } from "./context/theme"
import { Home } from "./routes/home"
import { PromptHistoryProvider } from "./prompt/history"
import { FrecencyProvider } from "./prompt/frecency"
import { PromptStashProvider } from "./prompt/stash"
import { Toast, ToastProvider, useToast } from "./ui/toast"
import { isFallbackTitle } from "@opencode-ai/util/session-title-fallback"
import * as Model from "./util/model"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import open from "open"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { Config, ConfigProvider, useConfig } from "./config"
import { newSessionLocation } from "./config/new-session-location"
import { PluginProvider, usePlugin, type PackageSource } from "./plugin/context"
import { localPluginDirectories } from "./plugin/discovery"
import { PluginRoute, Slot } from "./plugin/render"
import { CommandPaletteDialog } from "./component/command-palette"
import { COMMAND_PALETTE_COMMAND, Keymap, type KeymapCommand } from "./context/keymap"
import { useI18n } from "./context/i18n"
import { translate, type Translator } from "./i18n"

import { DialogVariant } from "./component/dialog-variant"
import { destroyRenderer } from "./util/renderer"
import { cliErrorMessage, errorFormat } from "./util/error"
import { AttentionProvider } from "./context/attention"
import { StorageProvider, useStorage } from "./context/storage"
import { SessionTerminalsProvider } from "./context/session-terminals"
import { SessionFrame } from "./component/session-frame"
import { createTuiClipboard } from "./clipboard"

registerOpencodeSpinner()

const appGlobalBindingCommands = ["session.list", "session.new", "open.menu"] as const

const sessionTabBindingCommands = [
  "session.tab.next",
  "session.tab.previous",
  "session.tab.next_unread",
  "session.tab.previous_unread",
  "session.tab.close",
  "session.tab.reopen",
  "session.tab.select.1",
  "session.tab.select.2",
  "session.tab.select.3",
  "session.tab.select.4",
  "session.tab.select.5",
  "session.tab.select.6",
  "session.tab.select.7",
  "session.tab.select.8",
  "session.tab.select.9",
  "session.tab.select.10",
] as const

const pinnedSessionBindingCommands = [
  "session.quick_switch.1",
  "session.quick_switch.2",
  "session.quick_switch.3",
  "session.quick_switch.4",
  "session.quick_switch.5",
  "session.quick_switch.6",
  "session.quick_switch.7",
  "session.quick_switch.8",
  "session.quick_switch.9",
] as const

const appBindingCommands = [
  "command.palette.show",
  "model.list",
  "model.cycle_recent",
  "model.cycle_recent_reverse",
  "model.cycle_favorite",
  "model.cycle_favorite_reverse",
  "agent.list",
  "mcp.list",
  "agent.cycle",
  "agent.cycle.reverse",
  "variant.cycle",
  "variant.list",
  "provider.connect",
  "opencode.settings",
  "opencode.status",
  "server.pair",
  "service.restart",
  "opencode.debug",
  "theme.switch",
  "theme.switch_mode",
  "theme.mode.lock",
  "help.show",
  "docs.open",
  "diff.open",
  "app.debug",
  "app.console",
  "terminal.suspend",
  "terminal.title.toggle",
  "app.toggle.animations",
  "app.toggle.file_context",
  "app.toggle.diffwrap",
  "app.toggle.paste_summary",
  "permission.mode",
] as const

export type TuiInput = {
  app: TuiApp
  server: {
    endpoint: Endpoint
    service?: {
      reconnect: (signal: AbortSignal) => Promise<Endpoint>
      restart: () => Promise<void>
    }
  }
  args: Args
  config: Config.Interface
  updater?: {
    monitor: (notify: (version: string) => void, signal: AbortSignal) => Promise<void>
    apply: (version: string) => Promise<void>
  }
  packages: PackageSource
  environment?: Readonly<Record<string, string>>
  terminalHandoff?: () => Promise<
    | {
        readonly renderer: CliRenderer
        readonly mode: ThemeMode | null
        readonly complete: () => void
      }
    | undefined
  >
  log?: LogSink
}

export const run = Effect.fn("Tui.run")(function* (input: TuiInput) {
  const log = input.log ?? (() => {})
  const global = yield* Global.Service
  const config = Config.resolve(yield* Effect.tryPromise(() => input.config.get()), {
    terminalSuspend: process.platform !== "win32",
  })
  const t: Translator = (key, params) => translate(config.locale, key, params)
  const options = { baseUrl: input.server.endpoint.url, headers: Service.headers(input.server.endpoint) }
  const api = OpenCode.make(options)
  const location = yield* Effect.tryPromise(() => api.file.list({ location: { directory: process.cwd() } })).pipe(
    Effect.map((response) => response.location),
    Effect.catch(() => Effect.tryPromise(() => api.location.get())),
  )
  const directory = location.directory
  const pluginDirectories = yield* Effect.promise(() => localPluginDirectories(process.cwd(), global.config))
  const handoff = input.terminalHandoff ? yield* Effect.promise(input.terminalHandoff) : undefined
  const managed = input.server.service
  const service = managed
    ? {
        reconnect: async (signal: AbortSignal) => {
          const endpoint = await managed.reconnect(signal)
          const next = { baseUrl: endpoint.url, headers: Service.headers(endpoint) }
          return { api: OpenCode.make(next), url: endpoint.url }
        },
        restart: managed.restart,
      }
    : undefined
  const exit = { epilogue: undefined as string | undefined, reason: undefined as unknown }
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const options = {
        externalOutputMode: "passthrough",
        targetFps: 60,
        gatherStats: false,
        exitOnCtrlC: false,
        useKittyKeyboard: {},
        autoFocus: false,
        openConsoleOnError: false,
        useMouse: config.mouse,
        consoleOptions: {
          keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
        },
      } satisfies CliRendererConfig
      const renderer = yield* Effect.gen(function* () {
        if (handoff) {
          handoff.renderer.useMouse = options.useMouse
          return yield* Effect.acquireRelease(Effect.succeed(handoff.renderer), (renderer) =>
            Effect.sync(() => destroyRenderer(renderer)),
          )
        }
        if (process.env.OPENCODE_DRIVE) {
          const { Drive } = yield* Effect.promise(() => import("@opencode-ai/simulation/frontend"))
          return yield* Drive.create(options, input.app.version)
        }
        return yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => createCliRenderer(options),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }),
          (renderer) => Effect.sync(() => destroyRenderer(renderer)),
        )
      })
      const clipboard = yield* Effect.acquireRelease(
        Effect.sync(() => createTuiClipboard(renderer)),
        (clipboard) =>
          Effect.tryPromise(() => clipboard.dispose()).pipe(
            Effect.catch((error) => Effect.sync(() => log("error", "Failed to dispose TUI clipboard", { error }))),
          ),
      )
      const finalizers = new Set<() => Promise<void>>()
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          const results = await Promise.allSettled([...finalizers].reverse().map((finalizer) => finalizer()))
          results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .forEach((result) => log("error", "Failed to dispose TUI resource", { error: result.reason }))
        }),
      )
      const shutdown = yield* Latch.make()
      const onSighup = () => destroyRenderer(renderer)
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGHUP", onSighup)),
        () => Effect.sync(() => process.off("SIGHUP", onSighup)),
      )
      renderer.once("destroy", () => shutdown.openUnsafe())
      yield* Effect.tryPromise(async () => {
        // Prewarm palette before ThemeProvider mounts so `system` theme avoids a first-paint fallback flash.
        void renderer.getPalette({ size: 16 }).catch(() => undefined)
        const mode = handoff?.mode ?? (await renderer.waitForThemeMode(1000)) ?? "dark"
        if (renderer.isDestroyed) return

        await render(() => {
          return (
            <LogProvider log={log}>
              <ExitProvider
                exit={(reason) => {
                  if (renderer.isDestroyed) return
                  exit.reason = reason
                  destroyRenderer(renderer)
                }}
              >
                <EpilogueProvider set={(value) => (exit.epilogue = value)}>
                  <TuiAppProvider value={input.app}>
                    <ErrorBoundary
                      fallback={(error, reset) => (
                        <ClipboardProvider value={clipboard}>
                          <ErrorComponent error={error} reset={reset} mode={mode} />
                        </ClipboardProvider>
                      )}
                    >
                      <TuiPathsProvider
                        value={{
                          cwd: process.cwd(),
                          home: global.home,
                          state: global.state,
                          worktree: global.data + "/worktree",
                        }}
                      >
                        <StorageProvider>
                          <TuiLifecycleProvider
                            value={{
                              add(finalizer) {
                                finalizers.add(finalizer)
                                return () => finalizers.delete(finalizer)
                              },
                            }}
                          >
                            <TuiTerminalEnvironmentProvider
                              value={{
                                platform: process.platform,
                                multiplexer: process.env.TMUX ? "tmux" : process.env.STY ? "screen" : undefined,
                                displayServer: process.env.WAYLAND_DISPLAY
                                  ? "wayland"
                                  : process.env.DISPLAY
                                    ? "x11"
                                    : undefined,
                                variables: input.environment,
                              }}
                            >
                              <TuiStartupProvider
                                value={{
                                  initialRoute: process.env.OPENCODE_STORY
                                    ? {
                                        type: "plugin",
                                        id: "opencode.storybook",
                                        name: "storybook",
                                        // OPENCODE_STORY=1 opens the index; any other value opens that story.
                                        data:
                                          process.env.OPENCODE_STORY === "1"
                                            ? undefined
                                            : { story: process.env.OPENCODE_STORY },
                                      }
                                    : process.env.OPENCODE_ROUTE
                                      ? JSON.parse(process.env.OPENCODE_ROUTE)
                                      : undefined,
                                  skipInitialLoading: Boolean(process.env.OPENCODE_FAST_BOOT),
                                }}
                              >
                                <ClipboardProvider value={clipboard}>
                                  <ArgsProvider {...input.args}>
                                    <ConfigProvider
                                      config={config}
                                      service={input.config}
                                      options={{ terminalSuspend: process.platform !== "win32" }}
                                    >
                                      <Keymap.Provider>
                                        <ToastProvider>
                                          <RouteProvider
                                            initialRoute={
                                              input.args.continue
                                                ? {
                                                    type: "session",
                                                    sessionID: "dummy",
                                                  }
                                                : undefined
                                            }
                                          >
                                            <ClientProvider api={api} url={input.server.endpoint.url} service={service}>
                                              <PermissionProvider>
                                                <DataProvider directory={directory}>
                                                  <LocationProvider>
                                                    <SessionTabsProvider>
                                                      <SessionTerminalsProvider>
                                                        <ThemeProvider
                                                          mode={mode}
                                                          source={createThemeSource(global.config)}
                                                        >
                                                          <ThemeErrorToast />
                                                          <LocalProvider>
                                                            <PromptStashProvider>
                                                              <DialogProvider>
                                                                <FrecencyProvider>
                                                                  <PromptHistoryProvider>
                                                                    <PromptRefProvider>
                                                                      <EditorContextProvider>
                                                                        <AttentionProvider>
                                                                          <PluginProvider
                                                                            packages={input.packages}
                                                                            directories={pluginDirectories}
                                                                          >
                                                                            <App
                                                                              updater={input.updater}
                                                                              pair={
                                                                                input.server.endpoint.auth
                                                                                  ? input.server.endpoint.auth
                                                                                  : {
                                                                                      username: "opencode",
                                                                                      password: "",
                                                                                    }
                                                                              }
                                                                            />
                                                                          </PluginProvider>
                                                                        </AttentionProvider>
                                                                      </EditorContextProvider>
                                                                    </PromptRefProvider>
                                                                  </PromptHistoryProvider>
                                                                </FrecencyProvider>
                                                              </DialogProvider>
                                                            </PromptStashProvider>
                                                          </LocalProvider>
                                                        </ThemeProvider>
                                                      </SessionTerminalsProvider>
                                                    </SessionTabsProvider>
                                                  </LocationProvider>
                                                </DataProvider>
                                              </PermissionProvider>
                                            </ClientProvider>
                                          </RouteProvider>
                                        </ToastProvider>
                                      </Keymap.Provider>
                                    </ConfigProvider>
                                  </ArgsProvider>
                                </ClipboardProvider>
                              </TuiStartupProvider>
                            </TuiTerminalEnvironmentProvider>
                          </TuiLifecycleProvider>
                        </StorageProvider>
                      </TuiPathsProvider>
                    </ErrorBoundary>
                  </TuiAppProvider>
                </EpilogueProvider>
              </ExitProvider>
            </LogProvider>
          )
        }, renderer)
        if (handoff) {
          renderer.once(CliRenderEvents.FRAME, handoff.complete)
          renderer.requestRender()
        }
      })
      yield* shutdown.await
      return { epilogue: exit.epilogue, reason: exit.reason }
    }),
  )
  yield* Effect.sync(() => {
    if (result.reason !== undefined)
      process.stderr.write((cliErrorMessage(result.reason, t) ?? errorFormat(result.reason)) + "\n")
    if (result.epilogue) process.stdout.write(result.epilogue + "\n")
  })
})

function App(props: { pair?: DialogPairCredentials; updater?: TuiInput["updater"] }) {
  const log = useLog({ component: "app" })
  const app = useTuiApp()
  const startup = useTuiStartup()
  const config = useConfig()
  const i18n = useI18n()
  const devtools = createMemo(() => config.data.debug?.devtools ?? app.channel === "local")
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const sessionTabs = useSessionTabs()
  const keymap = Keymap.use()
  const event = useEvent()
  const client = useClient()
  const toast = useToast()
  const theme = useTheme()
  const tabsTheme = useTheme("elevated")
  const { mode, supports, setMode, locked, lock, unlock } = useThemes()
  const data = useData()
  const location = useLocation()
  const exit = useExit()
  const promptRef = usePromptRef()
  const plugins = usePlugin()
  const clipboard = useClipboard()
  const terminalEnvironment = useTuiTerminalEnvironment()
  createEffect(() => {
    if (client.connection.status() !== "connected") return
    if (route.data.type !== "session") return
    const session = data.session.get(route.data.sessionID)
    if (!session) return
    if (data.session.creating(session.id)) return
    if (session.location.workspaceID !== undefined || terminalEnvironment.variables === undefined) return
    void client.api.session
      .environment({ sessionID: session.id, variables: terminalEnvironment.variables })
      .catch(toast.error)
  })
  const [layout, updateLayout] = useStorage().store<{ verticalTabsWidth?: number }>("layout", {
    initial: { verticalTabsWidth: SESSION_SIDEBAR_WIDTH },
  })
  const [updateNotifications, markUpdateNotification] = useStorage().store<{ versions: string[] }>(
    "update-notifications",
    { initial: { versions: [] } },
  )
  const showUpdate = (version: string) => {
    const updater = props.updater
    if (!updater || updateNotifications.versions.includes(version)) return
    void markUpdateNotification((draft) => {
      draft.versions = [...draft.versions, version].slice(-100)
    }).catch((error) => log.error("failed to persist update notification", { error }))
    const key = `update:${version}`
    dialog.replace(
      () => (
        <DialogUpdate
          dialogKey={key}
          version={version}
          install={() => updater.apply(version)}
          restart={client.restart}
        />
      ),
      undefined,
      { key },
    )
    dialog.setCentered(true)
  }
  onMount(() => {
    const updater = props.updater
    if (!updater) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    void updater.monitor(showUpdate, controller.signal).catch((error) => {
      if (!controller.signal.aborted) log.error("update monitor failed", { error })
    })
  })
  const [preferredTabsWidth, setPreferredTabsWidth] = createSignal(layout.verticalTabsWidth ?? SESSION_SIDEBAR_WIDTH)
  const [tabsResizeHovered, setTabsResizeHovered] = createSignal(false)
  const [tabsResizing, setTabsResizing] = createSignal(false)
  let requestedTabsWidth = layout.verticalTabsWidth ?? SESSION_SIDEBAR_WIDTH
  createEffect(() => {
    if (tabsResizing()) return
    requestedTabsWidth = layout.verticalTabsWidth ?? SESSION_SIDEBAR_WIDTH
    setPreferredTabsWidth(requestedTabsWidth)
  })
  const verticalTabsWidth = () => clampSessionTabsWidth(preferredTabsWidth(), dimensions().width)
  const resizeVerticalTabs = (width: number) => setPreferredTabsWidth(clampSessionTabsWidth(width, dimensions().width))
  const commitVerticalTabsWidth = (width: number) => {
    const next = clampSessionTabsWidth(width, dimensions().width)
    setPreferredTabsWidth(next)
    if (requestedTabsWidth === next) return
    requestedTabsWidth = next
    void updateLayout((draft) => {
      draft.verticalTabsWidth = next
    }).catch((error) => console.error("Failed to persist TUI layout", error))
  }
  let tabsResizeMoved = false
  let lastTabsBoundaryClick = 0
  const finishTabsResize = (event: MouseEvent) => {
    if (!tabsResizing()) return
    const next = tabsResizeMoved ? event.x + 1 : verticalTabsWidth()
    setTabsResizing(false)
    lastTabsBoundaryClick = tabsResizeMoved ? 0 : Date.now()
    commitVerticalTabsWidth(next)
    const width = clampSessionTabsWidth(next, dimensions().width)
    setTabsResizeHovered(event.x >= width - 1 && event.x <= width)
    event.stopPropagation()
  }
  let openingOpen: Promise<SessionInfo[]> | undefined
  // Toast once when an MCP server enters a failed or needs-auth state so the user knows to act,
  // without having to open the status panel. Tracking the last alerted status avoids re-toasting
  // the same problem on every refresh while still re-alerting if the state changes.
  const mcpAlerted: Record<string, string> = {}
  createEffect(() => {
    for (const server of data.location.mcp.server.list() ?? []) {
      const status = server.status
      if (status.status !== "failed" && status.status !== "needs_auth") {
        delete mcpAlerted[server.name]
        continue
      }
      if (mcpAlerted[server.name] === status.status) continue
      mcpAlerted[server.name] = status.status
      if (status.status === "needs_auth")
        toast.show({
          variant: "warning",
          title: i18n.t("app.mcp.needsAuth.title"),
          message: i18n.t("app.mcp.needsAuth.message", { name: server.name }),
          action: { label: i18n.t("app.mcp.needsAuth.action"), run: () => keymap.dispatch("mcp.list") },
        })
      else
        toast.show({
          variant: "error",
          title: i18n.t("app.mcp.failed.title", { name: server.name }),
          message: i18n.t("app.mcp.failed.message"),
          action: { label: i18n.t("app.mcp.needsAuth.action"), run: () => keymap.dispatch("mcp.list") },
        })
    }
  })

  const copyOnSelectEnabled = () =>
    (config.data.terminal?.copy ?? (process.platform === "win32" ? "manual" : "select")) === "select"

  // Selection copy/dismiss must precede both app bindings and the terminal pane's raw key forwarding.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      Selection.handleSelectionKey(renderer, toast, event, clipboard, copyOnSelectEnabled(), i18n.t("app.copy.success"))
    },
    { priority: 101 },
  )
  onCleanup(() => {
    offSelectionKeys()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await clipboard
      .write(text)
      .then(() => toast.show({ message: i18n.t("app.copy.success"), variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const terminalTitleEnabled = () => config.data.terminal?.title ?? true
  const pasteSummaryEnabled = () => config.data.prompt?.paste !== "full"
  const tabsVertical = () =>
    config.data.tabs.layout === "vertical" && sessionTabsFitVertically(dimensions().width, preferredTabsWidth())
  const tabsVisible = () => sessionTabs.enabled() && sessionTabs.tabs().length > 0 && route.data.type !== "plugin"
  const verticalTabsVisible = () => tabsVisible() && tabsVertical()

  createEffect(() => {
    renderer.useMouse = config.data.mouse
  })

  let active: { id: string; title?: string } | undefined
  // Update terminal window title based on current route and session
  createEffect(() => {
    const session = route.data.type === "session" ? data.session.get(route.data.sessionID) : undefined
    if (session) active = { id: session.id, title: session.title }
    if (!terminalTitleEnabled()) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle("OpenCode")
      return
    }

    if (route.data.type === "session") {
      const title = session?.title
      if (!title || isFallbackTitle(title)) {
        renderer.setTerminalTitle("OpenCode")
        return
      }

      renderer.setTerminalTitle(`OC | ${title.length > 40 ? title.slice(0, 37) + "…" : title}`)
      return
    }

    if (route.data.type === "plugin") {
      renderer.setTerminalTitle(`OC | ${route.data.name}`)
    }
  })

  const args = useArgs()
  const startupPrompt = args.prompt ? { text: args.prompt, files: [], agents: [], pasted: [] } : undefined
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.model) {
        const { providerID, modelID } = Model.parse(args.model)
        if (!providerID || !modelID)
          return toast.show({
            variant: "warning",
            message: i18n.t("app.model.invalid", { model: args.model }),
            duration: 3000,
          })
        local.model.set({ providerID, modelID }, { recent: true })
      }
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
          prompt: startupPrompt,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    if (continued || !args.continue) return
    continued = true
    const location = data.location.default()
    void client.api.session
      .list({
        limit: 1,
        order: "desc",
        parentID: null,
        directory: location.directory,
        workspace: location.workspaceID,
      })
      .then((response) => {
        const match = response.data[0]?.id
        if (!match) return
        if (!args.fork) {
          route.navigate({ type: "session", sessionID: match, prompt: startupPrompt })
          return
        }
        void client.api.session
          .fork({ sessionID: match, boundary: { type: "through" } })
          .then((result) => route.navigate({ type: "session", sessionID: result.id, prompt: startupPrompt }))
          .catch(toast.error)
      })
      .catch(toast.error)
  })

  // Handle --session with --fork once.
  let forked = false
  createEffect(() => {
    if (forked || !args.sessionID || !args.fork) return
    forked = true
    void client.api.session
      .fork({ sessionID: args.sessionID, boundary: { type: "through" } })
      .then((result) => route.navigate({ type: "session", sessionID: result.id, prompt: startupPrompt }))
      .catch(toast.error)
  })

  const connected = useConnected()
  const appCommands = createMemo(() =>
    [
      {
        name: COMMAND_PALETTE_COMMAND,
        title: i18n.t("app.command.commandPalette"),
        category: i18n.t("app.category.system"),
        palette: undefined,
        run: () => {
          dialog.replace(() => <CommandPaletteDialog />)
        },
      },
      {
        name: "session.list",
        title: i18n.t("app.command.session.switch"),
        category: i18n.t("app.category.session"),
        suggested: data.session.list().length > 0,
        slash: { name: "sessions", aliases: ["resume", "continue"] },
        run: () => {
          dialog.replace(() => <DialogSessionList />)
        },
      },
      {
        name: "session.new",
        title: i18n.t("app.command.session.new"),
        suggested: route.data.type === "session",
        category: i18n.t("app.category.session"),
        slash: { name: "new", aliases: ["clear"] },
        run: () => {
          const model = local.model.current()
          const current =
            route.data.type === "session"
              ? (data.session.get(route.data.sessionID)?.location ?? location.ref)
              : undefined
          route.navigate({
            type: "home",
            location: newSessionLocation(
              config.data.session.new_location,
              data.location.default().directory,
              current,
              location.error?.location,
            ),
          })
          if (model) local.model.set(model)
          dialog.clear()
        },
      },
      {
        name: "open.menu",
        title: i18n.t("app.command.open"),
        category: i18n.t("app.category.session"),
        slash: { name: "open", aliases: ["projects", "project"] },
        run: async () => {
          if (dialog.key === DialogOpenKey || openingOpen) return
          const previous = dialog.stack.at(-1)
          openingOpen = loadDialogOpen(data, client)
          const sessions = await openingOpen
          openingOpen = undefined
          if (dialog.stack.at(-1) !== previous) return
          dialog.replace(() => <DialogOpen sessions={sessions} />, undefined, { key: DialogOpenKey, size: "large" })
        },
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `session.quick_switch.${i + 1}`,
        title: i18n.t("app.command.quickSlot", { index: i + 1 }),
        category: i18n.t("app.category.session"),
        palette: undefined,
        enabled: () => !sessionTabs.enabled(),
        run: () => local.session.quickSwitch(i + 1),
      })),
      {
        name: "session.tab.next",
        title: i18n.t("app.command.tab.next"),
        category: i18n.t("app.category.session"),
        palette: undefined,
        enabled: sessionTabs.enabled,
        run: () => sessionTabs.cycle(1),
      },
      {
        name: "session.tab.previous",
        title: i18n.t("app.command.tab.previous"),
        category: i18n.t("app.category.session"),
        palette: undefined,
        enabled: sessionTabs.enabled,
        run: () => sessionTabs.cycle(-1),
      },
      {
        name: "session.tab.next_unread",
        title: i18n.t("app.command.tab.nextUnread"),
        category: i18n.t("app.category.session"),
        palette: undefined,
        enabled: sessionTabs.enabled,
        run: () => sessionTabs.cycleUnread(1),
      },
      {
        name: "session.tab.previous_unread",
        title: i18n.t("app.command.tab.previousUnread"),
        category: i18n.t("app.category.session"),
        palette: undefined,
        enabled: sessionTabs.enabled,
        run: () => sessionTabs.cycleUnread(-1),
      },
      {
        name: "session.tab.close",
        title: i18n.t("app.command.tab.close"),
        category: i18n.t("app.category.session"),
        enabled: sessionTabs.enabled,
        run: () => sessionTabs.close(),
      },
      {
        name: "session.tab.reopen",
        title: i18n.t("app.command.tab.reopen"),
        category: i18n.t("app.category.session"),
        enabled: sessionTabs.enabled,
        run: () => sessionTabs.reopen(),
      },
      ...Array.from({ length: 10 }, (_, i) => ({
        name: `session.tab.select.${i + 1}`,
        title: i18n.t("app.command.tab.select", { index: i + 1 }),
        category: i18n.t("app.category.session"),
        palette: undefined,
        enabled: sessionTabs.enabled,
        run: () => sessionTabs.selectIndex(i),
      })),
      {
        name: "model.list",
        title: i18n.t("app.command.model.switch"),
        suggested: true,
        category: i18n.t("app.category.agent"),
        // Bias /mo toward /models over /move without changing global fuzzy scoring.
        slash: { name: "models", aliases: ["mo"] },
        run: () => {
          dialog.replace(() => <DialogModel />)
        },
      },
      {
        name: "model.cycle_recent",
        title: i18n.t("app.command.model.cycle"),
        category: i18n.t("app.category.agent"),
        palette: undefined,
        run: () => {
          local.model.cycle(1)
        },
      },
      {
        name: "model.cycle_recent_reverse",
        title: i18n.t("app.command.model.cycleReverse"),
        category: i18n.t("app.category.agent"),
        palette: undefined,
        run: () => {
          local.model.cycle(-1)
        },
      },
      {
        name: "model.cycle_favorite",
        title: i18n.t("app.command.favorite.cycle"),
        category: i18n.t("app.category.agent"),
        palette: undefined,
        run: () => {
          local.model.cycleFavorite(1)
        },
      },
      {
        name: "model.cycle_favorite_reverse",
        title: i18n.t("app.command.favorite.cycleReverse"),
        category: i18n.t("app.category.agent"),
        palette: undefined,
        run: () => {
          local.model.cycleFavorite(-1)
        },
      },
      {
        name: "agent.list",
        title: i18n.t("app.command.agent.switch"),
        category: i18n.t("app.category.agent"),
        slash: { name: "agents" },
        run: () => {
          dialog.replace(() => <DialogAgent />)
        },
      },
      {
        name: "mcp.list",
        title: i18n.t("app.command.mcp.list"),
        category: i18n.t("app.category.agent"),
        slash: { name: "mcps" },
        run: () => {
          dialog.replace(() => <DialogMcp />)
        },
      },
      {
        name: "agent.cycle",
        title: i18n.t("app.command.agent.cycle"),
        category: i18n.t("app.category.agent"),
        palette: undefined,
        run: () => {
          local.agent.move(1)
        },
      },
      {
        name: "variant.cycle",
        title: i18n.t("app.command.variant.cycle"),
        category: i18n.t("app.category.agent"),
        run: () => {
          local.model.variant.cycle()
        },
      },
      {
        name: "variant.list",
        title: i18n.t("app.command.variant.switch"),
        category: i18n.t("app.category.agent"),
        palette: local.model.variant.list().length === 0 ? undefined : (true as const),
        slash: { name: "variants" },
        run: () => {
          if (local.model.variant.list().length === 0) {
            return toast.show({
              title: i18n.t("app.variant.none.title"),
              message: i18n.t("app.variant.none.message"),
              variant: "info",
            })
          }
          dialog.replace(() => <DialogVariant />)
        },
      },
      {
        name: "agent.cycle.reverse",
        title: i18n.t("app.command.agent.cycleReverse"),
        category: i18n.t("app.category.agent"),
        palette: undefined,
        run: () => {
          local.agent.move(-1)
        },
      },
      {
        name: "provider.connect",
        title: i18n.t("app.command.integration.connect"),
        suggested: !connected(),
        slash: { name: "connect" },
        run: () => {
          dialog.replace(() => (
            <DialogIntegration
              onConnected={(providerID) => dialog.replace(() => <DialogModel providerID={providerID} />)}
            />
          ))
        },
        category: i18n.t("app.category.integration"),
      },
      {
        name: "opencode.settings",
        title: i18n.t("app.command.settings"),
        suggested: true,
        slash: { name: "settings" },
        run: () => {
          dialog.replace(() => <DialogConfig />)
        },
        category: i18n.t("app.category.system"),
      },
      {
        name: "opencode.status",
        title: i18n.t("app.command.status"),
        slash: { name: "status" },
        run: () => {
          dialog.replace(() => <DialogStatus />)
        },
        category: i18n.t("app.category.system"),
      },
      {
        name: "server.pair",
        title: i18n.t("app.command.pair"),
        slash: { name: "pair", aliases: ["web"] },
        run: () => {
          dialog.replace(() => <DialogPair credentials={props.pair} />)
        },
        category: i18n.t("app.category.system"),
      },
      ...(client.restart
        ? [
            {
              name: "service.restart",
              title: i18n.t("app.command.service.restart"),
              slash: { name: "restart" },
              run: async () => {
                const restart = client.restart
                if (!restart) return
                dialog.clear()
                toast.show({ variant: "info", message: i18n.t("app.service.restarting"), duration: 30000 })
                // restart resolves once the replacement service is healthy; the
                // event stream reattaches through the reconnect loop.
                await restart()
                  .then(() => toast.show({ variant: "success", message: i18n.t("app.service.restarted") }))
                  .catch(toast.error)
              },
              category: i18n.t("app.category.system"),
            },
          ]
        : []),
      {
        name: "opencode.debug",
        title: i18n.t("app.command.debug.info"),
        slash: { name: "debug" },
        run: () => {
          dialog.replace(() => <DialogDebug />)
        },
        category: i18n.t("app.category.system"),
      },
      {
        name: "theme.switch",
        title: i18n.t("app.command.theme.switch"),
        slash: { name: "themes" },
        run: () => {
          dialog.replace(() => <DialogThemeList />)
        },
        category: i18n.t("app.category.system"),
      },
      {
        name: "theme.switch_mode",
        title: mode() === "dark" ? i18n.t("app.command.theme.modeLight") : i18n.t("app.command.theme.modeDark"),
        palette: undefined,
        enabled: () => supports(mode() === "dark" ? "light" : "dark"),
        run: () => {
          setMode(mode() === "dark" ? "light" : "dark")
          dialog.clear()
        },
        category: i18n.t("app.category.system"),
      },
      {
        name: "theme.mode.lock",
        title: locked() ? i18n.t("app.command.theme.unlock") : i18n.t("app.command.theme.lock"),
        palette: undefined,
        run: () => {
          if (locked()) unlock()
          else lock()
          dialog.clear()
        },
        category: i18n.t("app.category.system"),
      },
      {
        name: "help.show",
        title: i18n.t("app.command.help"),
        slash: { name: "help" },
        run: () => {
          dialog.replace(() => <DialogHelp />)
        },
        category: i18n.t("app.category.system"),
      },
      {
        name: "docs.open",
        title: i18n.t("app.command.docs.open"),
        run: () => {
          open("https://opencode.ai/docs").catch(() => {})
          dialog.clear()
        },
        category: i18n.t("app.category.system"),
      },
      {
        name: "app.exit",
        title: i18n.t("app.command.exit"),
        slash: { name: "exit", aliases: ["quit", "q"] },
        run: () => exit(),
        category: i18n.t("app.category.system"),
      },
      {
        name: "app.debug",
        title: i18n.t("app.command.debug.toggle"),
        category: i18n.t("app.category.system"),
        palette: undefined,
        run: () => {
          renderer.toggleDebugOverlay()
          dialog.clear()
        },
      },
      {
        name: "app.console",
        title: i18n.t("app.command.console.toggle"),
        category: i18n.t("app.category.system"),
        run: () => {
          renderer.console.toggle()
          dialog.clear()
        },
      },
      {
        name: "terminal.suspend",
        title: i18n.t("app.command.terminal.suspend"),
        category: i18n.t("app.category.system"),
        palette: undefined,
        enabled: process.platform !== "win32",
        run: () => {
          renderer.suspend()
          process.once("SIGCONT", () => renderer.resume())
          process.kill(0, "SIGTSTP")
        },
      },
      {
        name: "terminal.title.toggle",
        title: terminalTitleEnabled()
          ? i18n.t("app.command.terminalTitle.disable")
          : i18n.t("app.command.terminalTitle.enable"),
        category: i18n.t("app.category.system"),
        palette: undefined,
        run: () => {
          const next = !terminalTitleEnabled()
          if (!next) renderer.setTerminalTitle("")
          void config
            .update((draft) => {
              draft.terminal = { ...draft.terminal, title: next }
            })
            .catch(toast.error)
          dialog.clear()
        },
      },
      {
        name: "app.toggle.animations",
        title:
          (config.data.animations ?? true)
            ? i18n.t("app.command.animations.disable")
            : i18n.t("app.command.animations.enable"),
        category: i18n.t("app.category.system"),
        palette: undefined,
        run: () => {
          void config
            .update((draft) => {
              draft.animations = !(config.data.animations ?? true)
            })
            .catch(toast.error)
          dialog.clear()
        },
      },
      {
        name: "app.toggle.file_context",
        title:
          (config.data.prompt?.editor ?? true)
            ? i18n.t("app.command.fileContext.disable")
            : i18n.t("app.command.fileContext.enable"),
        category: i18n.t("app.category.system"),
        palette: undefined,
        run: () => {
          void config
            .update((draft) => {
              draft.prompt = { ...draft.prompt, editor: !(config.data.prompt?.editor ?? true) }
            })
            .catch(toast.error)
          dialog.clear()
        },
      },
      {
        name: "app.toggle.diffwrap",
        title:
          (config.data.diffs?.wrap ?? "word") === "word"
            ? i18n.t("app.command.diffWrap.disable")
            : i18n.t("app.command.diffWrap.enable"),
        category: i18n.t("app.category.system"),
        palette: undefined,
        run: () => {
          void config
            .update((draft) => {
              draft.diffs = {
                ...draft.diffs,
                wrap: (config.data.diffs?.wrap ?? "word") === "word" ? "none" : "word",
              }
            })
            .catch(toast.error)
          dialog.clear()
        },
      },
      {
        name: "app.toggle.paste_summary",
        title: pasteSummaryEnabled()
          ? i18n.t("app.command.pasteSummary.disable")
          : i18n.t("app.command.pasteSummary.enable"),
        category: i18n.t("app.category.system"),
        palette: undefined,
        run: () => {
          void config
            .update((draft) => {
              draft.prompt = { ...draft.prompt, paste: pasteSummaryEnabled() ? "full" : "compact" }
            })
            .catch(toast.error)
          dialog.clear()
        },
      },
      {
        name: "permission.mode",
        title:
          local.permission.mode === "auto"
            ? i18n.t("app.command.autoApprove.disable")
            : i18n.t("app.command.autoApprove.enable"),
        category: i18n.t("app.category.system"),
        run: () => {
          local.permission.toggle()
          dialog.clear()
        },
      },
    ].map(
      ({ name, category, ...command }) =>
        ({
          id: name,
          group: category,
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    commands: appCommands(),
  }))

  Keymap.createLayer(() => ({
    bindings: appBindingCommands,
  }))

  Keymap.createLayer(() => ({
    mode: "global",
    bindings: appGlobalBindingCommands,
  }))

  Keymap.createLayer(() => ({
    mode: "global",
    enabled: sessionTabs.enabled,
    bindings: sessionTabBindingCommands,
  }))

  Keymap.createLayer(() => ({
    mode: "global",
    enabled: () => !sessionTabs.enabled(),
    bindings: pinnedSessionBindingCommands,
  }))

  Keymap.createLayer(() => ({
    enabled: () => {
      const current = promptRef.current
      if (!current?.focused) return true
      return current.current.text === ""
    },
    bindings: ["app.exit"],
  }))

  event.on("tui.command.execute", (evt, { workspace }) => {
    if (workspace !== (location.current?.workspaceID ?? data.location.default().workspaceID)) return
    keymap.dispatch(evt.data.command)
  })

  event.on("tui.toast.show", (evt, { workspace }) => {
    if (workspace !== (location.current?.workspaceID ?? data.location.default().workspaceID)) return
    toast.show({
      title: evt.data.title,
      message: evt.data.message,
      variant: evt.data.variant,
      duration: evt.data.duration,
    })
  })

  event.on("tui.session.select", (evt, { workspace }) => {
    if (workspace !== (location.current?.workspaceID ?? data.location.default().workspaceID)) return
    route.navigate({
      type: "session",
      sessionID: evt.data.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.data.sessionID) {
      const title = active?.id === evt.data.sessionID ? active.title : undefined
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: title ? i18n.t("app.session.deleted.named", { title }) : i18n.t("app.session.deleted.current"),
      })
    }
  })

  // Suppress the full-screen overlay for transient startup and event-stream retry states.
  // Initial connection gets a longer grace period; retries surface more quickly.
  const [showReconnecting, setShowReconnecting] = createSignal(false)
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    const status = client.connection.status()
    if (status === "connected") {
      setShowReconnecting(false)
      return
    }
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = undefined
        setShowReconnecting(true)
      },
      status === "reconnecting" ? 1000 : 5000,
    ).unref()
  })
  onCleanup(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background.default}
      onMouseDown={(evt) => {
        if (copyOnSelectEnabled()) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast, clipboard, i18n.t("app.copy.success"))) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={
        copyOnSelectEnabled()
          ? (event) => Selection.copyOnSelectRelease(event, renderer, toast, clipboard, i18n.t("app.copy.success"))
          : undefined
      }
    >
      <box
        flexGrow={1}
        minHeight={0}
        flexDirection="row"
        position="relative"
        onMouseDrag={(event) => {
          if (!tabsResizing()) return
          tabsResizeMoved = true
          lastTabsBoundaryClick = 0
          resizeVerticalTabs(event.x + 1)
          event.stopPropagation()
        }}
        onMouseDragEnd={finishTabsResize}
        onMouseUp={finishTabsResize}
      >
        <Show when={verticalTabsVisible()}>
          <SessionTabs orientation="vertical" width={verticalTabsWidth()} />
        </Show>
        <box flexGrow={1} minWidth={0} flexDirection="column">
          <Show when={plugins.ready()}>
            <box flexGrow={1} minHeight={0} flexDirection="column">
              <Show when={tabsVisible() && !tabsVertical()}>
                <SessionTabs />
              </Show>
              <Switch>
                <Match when={route.data.type === "home"}>
                  <Home />
                </Match>
                <Match when={route.data.type === "session"}>
                  <Show when={route.data.type === "session" ? route.data.sessionID : undefined} keyed>
                    {(sessionID) => (
                      <SessionFrame
                        sessionID={sessionID}
                        verticalTabsWidth={verticalTabsVisible() ? verticalTabsWidth() : 0}
                      />
                    )}
                  </Show>
                </Match>
                <Match when={route.data.type === "plugin"}>
                  <PluginRoute
                    fallback={(id, name) => (
                      <PluginRouteMissing id={id} name={name} onHome={() => route.navigate({ type: "home" })} />
                    )}
                  />
                </Match>
              </Switch>
            </box>
            <Slot path="app" />
          </Show>
        </box>
        <Show when={verticalTabsVisible()}>
          <box
            position="absolute"
            left={verticalTabsWidth() - 1}
            top={0}
            zIndex={10}
            width={2}
            height="100%"
            onMouseOver={() => setTabsResizeHovered(true)}
            onMouseOut={() => setTabsResizeHovered(false)}
            onMouseDown={(event) => {
              if (event.button !== MouseButton.LEFT) return
              const now = Date.now()
              if (now - lastTabsBoundaryClick < 300) {
                lastTabsBoundaryClick = 0
                setTabsResizing(false)
                setTabsResizeHovered(false)
                commitVerticalTabsWidth(SESSION_SIDEBAR_WIDTH)
                event.preventDefault()
                event.stopPropagation()
                return
              }
              tabsResizeMoved = false
              setTabsResizing(true)
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <box
              width={1}
              height="100%"
              backgroundColor={
                tabsResizeHovered() || tabsResizing() ? tabsTheme.background.action.primary.hovered : undefined
              }
            />
          </box>
        </Show>
      </box>
      <Show when={devtools() && !(route.data.type === "plugin" && route.data.id === "opencode.stats")}>
        <DevToolsBar />
      </Show>
      <Show when={!startup.skipInitialLoading}>
        <StartupLoading ready={plugins.ready} />
      </Show>
      <Show when={showReconnecting()}>
        <Reconnecting managed={client.restart !== undefined} />
      </Show>
      <MigrationOverlay />
      <Toast />
    </box>
  )
}
