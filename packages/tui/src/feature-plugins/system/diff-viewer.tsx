/** @jsxImportSource @opentui/solid */
import type { FileDiffInfo } from "@opencode-ai/client"
import { Plugin } from "@opencode-ai/plugin/tui"
import type { KeymapCommand, Route } from "@opencode-ai/plugin/tui/context"
import { TextAttributes, type BorderSides, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { LANGUAGE_EXTENSIONS } from "../../util/filetype"
import { useTerminalDimensions } from "@opentui/solid"
import path from "path"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { DiffViewerFileTree } from "./diff-viewer-file-tree"
import { Panel, PanelGroup, Separator } from "./diff-viewer-ui"
import { DialogSelect } from "../../ui/dialog-select"
import { getScrollAcceleration } from "../../util/scroll"
import { useConfig } from "../../config"
import { useI18n } from "../../context/i18n"
import { useThemes } from "../../context/theme"
import type { Translator } from "../../i18n"
import { PatchDiff, type PatchDiffRef } from "../../component/patch-diff"
import {
  allExpandedFileTreeDirectories,
  buildFileTree,
  fileTreeFileSelection,
  type FileTreeRow,
  flattenFileTree,
  moveFileTreeSelection,
  moveFileTreeSelectionToFirstChild,
  moveFileTreeSelectionToParent,
  movePatchFileIndex,
  orderedPatchFileIndexes,
  setFileTreeDirectoryExpanded,
  showDiffViewerFileTree,
  singlePatchFileIndex,
  toggleFileTreeDirectory,
} from "./diff-viewer-file-tree-utils"

const ROUTE = "diff"
const MIN_SPLIT_WIDTH = 100
const FILE_TREE_WIDTH = 32
const PLAIN_TEXT_FILETYPE = "opencode-plain-text"
const VCS_DIFF_CONTEXT_LINES = 12
type DiffMode = "working" | "branch"
type DiffViewerFocus = "patches" | "files"
type DiffView = "split" | "unified"
type SelectedHunk = { readonly fileIndex: number; readonly hunkIndex: number; readonly scrollTop: number }

type DiffFile = {
  readonly file: string
  readonly patch?: string
  readonly additions: number
  readonly deletions: number
  readonly status: "added" | "deleted" | "modified"
}

const normalizeDiffs = (diffs: readonly FileDiffInfo[]): DiffFile[] =>
  diffs.map((item) => ({
    file: item.file,
    patch: item.patch,
    additions: item.additions,
    deletions: item.deletions,
    status: item.status,
  }))

function filetype(input?: string) {
  if (!input) return "none"
  const language = LANGUAGE_EXTENSIONS[path.extname(input)]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function storedView(value: unknown): DiffView | undefined {
  if (value === "split" || value === "unified") return value
}

function diffSourceLabel(mode: DiffMode, t: Translator) {
  if (mode === "branch") return t("feature.diff.source.branch")
  return t("feature.diff.source.working")
}

function DiffViewer(props: { context: Plugin.Context }) {
  const i18n = useI18n()
  const dimensions = useTerminalDimensions()
  const config = useConfig()
  const dialog = props.context.ui.dialog
  const theme = props.context.theme
  const currentSyntax = useThemes().currentSyntax
  const params = () => {
    const route = props.context.ui.router.current()
    return (route.type === "plugin" ? route.data : undefined) as
      | {
          mode?: DiffMode
          sessionID?: string
          returnRoute?: Route
        }
      | undefined
  }
  const mode = () => params()?.mode ?? "working"
  const diffInput = createMemo(() => {
    const sessionID = params()?.sessionID
    return {
      mode: mode(),
      sessionID,
      location: sessionID
        ? (props.context.data.session.get(sessionID)?.location ?? props.context.data.location.default())
        : props.context.data.location.default(),
    }
  })
  const [diff] = createResource(diffInput, async (input) => {
    const result = await props.context.client.vcs.diff({
      location: input.location,
      mode: input.mode,
      context: VCS_DIFF_CONTEXT_LINES,
    })
    return normalizeDiffs(result.data ?? [])
  })
  const files = createMemo(() => (diff.error ? [] : (diff() ?? [])))
  const [focus, setFocus] = createSignal<DiffViewerFocus>("patches")
  const [fileTreeEnabled, setFileTreeEnabled] = createSignal(config.data.diffs?.tree ?? true)
  const showFileTree = createMemo(() => showDiffViewerFileTree(fileTreeEnabled(), files().length))
  const [singlePatch, setSinglePatch] = createSignal(config.data.diffs?.single ?? false)
  const patchPaneWidth = createMemo(() => dimensions().width - (showFileTree() ? 33 : 0) - 4)
  const patchLeftBorder = createMemo<BorderSides[]>(() => (showFileTree() ? ["left"] : []))
  const splitAvailable = createMemo(() => patchPaneWidth() >= MIN_SPLIT_WIDTH)
  const defaultView = createMemo(() => {
    if (config.data.diffs?.view === "unified") return "unified"
    if (config.data.diffs?.view === "split") return "split"
    return splitAvailable() ? "split" : "unified"
  })
  const [viewOverride, setViewOverride] = createSignal<DiffView | undefined>(storedView(config.data.diffs?.view))
  const view = createMemo(() => (splitAvailable() ? (viewOverride() ?? defaultView()) : "unified"))
  const fileTree = createMemo(() => buildFileTree(files()))
  const [expandedFileNodes, setExpandedFileNodes] = createSignal<ReadonlySet<number>>(new Set())
  const [highlightedFileNode, setHighlightedFileNode] = createSignal<number | undefined>()
  const [lastHighlightedFileNode, setLastHighlightedFileNode] = createSignal<number | undefined>()
  const [activePatchFileIndex, setActivePatchFileIndex] = createSignal<number | undefined>()
  const [selectedFileIndex, setSelectedFileIndex] = createSignal<number | undefined>()
  const [reviewedFileNames, setReviewedFileNames] = createSignal<ReadonlySet<string>>(new Set())
  const patchScrollAcceleration = createMemo(() => getScrollAcceleration(config.data))
  const fileRows = createMemo(() => flattenFileTree(fileTree(), expandedFileNodes()))
  const patchFileIndexes = createMemo(() => orderedPatchFileIndexes(flattenFileTree(fileTree())))
  const focusRunner = (input: Record<DiffViewerFocus, () => void>) => () => input[focus()]()
  const shortcut = (id: string) => () => props.context.keymap.shortcuts(id)[0]
  const switchFocusShortcut = shortcut("diff.switch_focus")
  const nextHunkShortcut = shortcut("diff.next_hunk")
  const previousHunkShortcut = shortcut("diff.previous_hunk")
  const nextFileShortcut = shortcut("diff.next_file")
  const previousFileShortcut = shortcut("diff.previous_file")
  const toggleFileTreeShortcut = shortcut("diff.toggle_file_tree")
  const singlePatchShortcut = shortcut("diff.single_patch")
  const switchSourceShortcut = shortcut("diff.switch_source")
  const toggleViewShortcut = shortcut("diff.toggle_view")
  const markReviewedShortcut = shortcut("diff.mark_reviewed")
  const helpShortcut = shortcut("diff.help")
  let scroll: ScrollBoxRenderable | undefined
  const patchNodeByFileIndex = new Map<number, BoxRenderable>()
  const patchDiffByFileIndex = new Map<number, PatchDiffRef>()
  const [selectedHunk, setSelectedHunk] = createSignal<SelectedHunk | undefined>()
  const [pendingPatchScrollFileIndex, setPendingPatchScrollFileIndex] = createSignal<number | undefined>()
  const [patchFillerHeight, setPatchFillerHeight] = createSignal(0)

  onCleanup(() => dialog.clear())

  createEffect(() => {
    setExpandedFileNodes(allExpandedFileTreeDirectories(fileTree()))
    setHighlightedFileNode(undefined)
    setLastHighlightedFileNode(undefined)
    setActivePatchFileIndex(undefined)
    setSelectedFileIndex(undefined)
    setSelectedHunk(undefined)
    setReviewedFileNames(new Set<string>())
  })

  const ensureHighlightedFileNode = () => {
    const highlighted = highlightedFileNode()
    if (highlighted !== undefined && fileRows().some((row) => row.id === highlighted)) return
    const lastHighlighted = lastHighlightedFileNode()
    const next =
      lastHighlighted !== undefined && fileRows().some((row) => row.id === lastHighlighted)
        ? lastHighlighted
        : fileRows().find((row) => row.fileIndex !== undefined)?.id
    setHighlightedFileNode(next)
  }

  const setHighlighted = (node: number | undefined) => {
    setHighlightedFileNode(node)
    if (node !== undefined) setLastHighlightedFileNode(node)
  }

  const moveFileSelection = (offset: number) =>
    setHighlighted(moveFileTreeSelection(fileRows(), highlightedFileNode(), offset))

  const clearFileTreePatchState = () => {
    setHighlightedFileNode(undefined)
    setActivePatchFileIndex(undefined)
    setSelectedHunk(undefined)
  }

  const scrollPatchNodeToTop = (patchNode: BoxRenderable) => {
    requestAnimationFrame(() => {
      if (!scroll) return
      const scrollDelta = patchNode.y - scroll.viewport.y
      const contentY = scroll.scrollTop + scrollDelta
      const offset = contentY === 0 ? 0 : 1
      scroll.scrollBy(scrollDelta + offset)
    })
  }

  const revealFileTreeFile = (fileIndex: number) => {
    const selection = fileTreeFileSelection(fileTree(), fileIndex)
    if (!selection) return
    setExpandedFileNodes((expanded) => {
      const next = new Set(expanded)
      selection.expandedNodes.forEach((node) => next.add(node))
      return next
    })
    setHighlighted(selection.highlightedNode)
  }

  const selectPatchFile = (fileIndex: number) => {
    revealFileTreeFile(fileIndex)
    setActivePatchFileIndex(fileIndex)
    setSelectedFileIndex(fileIndex)
  }

  const scrollToFileIndex = (fileIndex: number | undefined) => {
    if (fileIndex === undefined) return
    selectPatchFile(fileIndex)
    const patchNode = patchNodeByFileIndex.get(fileIndex)
    if (patchNode) scrollPatchNodeToTop(patchNode)
  }

  const jumpToFileIndex = (fileIndex: number | undefined) => {
    if (fileIndex === undefined) return
    setSelectedHunk(undefined)
    scrollToFileIndex(fileIndex)
  }

  const currentPatchFileIndex = () => {
    if (!scroll) return undefined
    const viewportContentY = scroll.scrollTop + 1
    const entries = patchFileIndexes()
      .map((fileIndex) => ({
        fileIndex,
        node: patchNodeByFileIndex.get(fileIndex),
      }))
      .filter((entry): entry is { fileIndex: number; node: BoxRenderable } => Boolean(entry.node))
      .map((entry) => ({
        ...entry,
        contentY: scroll!.scrollTop + entry.node.y - scroll!.viewport.y,
      }))
      .sort((left, right) => left.contentY - right.contentY)
    return entries.findLast((entry) => entry.contentY <= viewportContentY)?.fileIndex ?? entries[0]?.fileIndex
  }

  const jumpRelativePatchFile = (offset: number) => {
    setSelectedHunk(undefined)
    const next = movePatchFileIndex(patchFileIndexes(), selectedFileIndex() ?? activePatchFileIndex(), offset)
    if (singlePatch()) {
      if (next === undefined) return
      selectPatchFile(next)
      scrollSinglePatchToTop()
      return
    }
    scrollToFileIndex(next)
  }

  const jumpRelativeHunk = (offset: -1 | 1) => {
    const patchScroll = scroll
    if (!patchScroll) return
    const hunks = visiblePatchFiles()
      .flatMap((entry) => {
        return (
          patchDiffByFileIndex
            .get(entry.fileIndex)
            ?.hunks()
            .map((node, hunkIndex) => ({
              fileIndex: entry.fileIndex,
              hunkIndex,
              contentY: patchScroll.scrollTop + node.y - patchScroll.viewport.y - (hunkIndex > 0 ? 1 : 0),
            })) ?? []
        )
      })
      .sort((left, right) => left.contentY - right.contentY)
    const selected = selectedHunk()
    const selectedIndex =
      selected?.scrollTop === patchScroll.scrollTop
        ? hunks.findIndex((hunk) => hunk.fileIndex === selected.fileIndex && hunk.hunkIndex === selected.hunkIndex)
        : -1
    const next =
      selectedIndex !== -1
        ? hunks[selectedIndex + offset]
        : offset === 1
          ? hunks.find((hunk) => hunk.contentY > patchScroll.scrollTop)
          : hunks.findLast((hunk) => hunk.contentY < patchScroll.scrollTop)
    if (!next) return
    selectPatchFile(next.fileIndex)
    patchScroll.scrollTo(next.contentY)
    setSelectedHunk({ fileIndex: next.fileIndex, hunkIndex: next.hunkIndex, scrollTop: patchScroll.scrollTop })
  }

  const highlightedPatchFileIndex = () => fileRows().find((row) => row.id === highlightedFileNode())?.fileIndex
  const firstPatchFileIndex = () => fileRows().find((row) => row.fileIndex !== undefined)?.fileIndex
  const visiblePatchFiles = createMemo(() => {
    if (!singlePatch()) {
      return patchFileIndexes().flatMap((fileIndex) => {
        const file = files()[fileIndex]
        return file ? [{ file, fileIndex }] : []
      })
    }
    const fileIndex = singlePatchFileIndex(
      selectedFileIndex(),
      activePatchFileIndex(),
      currentPatchFileIndex(),
      firstPatchFileIndex(),
    )
    const file = fileIndex === undefined ? undefined : files()[fileIndex]
    return file && fileIndex !== undefined ? [{ file, fileIndex }] : []
  })

  const ensureHighlightedPatchFile = () => {
    const fileIndex = currentPatchFileIndex() ?? activePatchFileIndex() ?? firstPatchFileIndex()
    if (fileIndex === undefined) return
    selectPatchFile(fileIndex)
  }

  const scrollToPatchFileIndexAfterRender = (fileIndex: number) => {
    setPendingPatchScrollFileIndex(fileIndex)
    requestAnimationFrame(() => {
      const patchNode = patchNodeByFileIndex.get(fileIndex)
      if (patchNode) scrollPatchNodeToTop(patchNode)
      requestAnimationFrame(() => {
        const patchNode = patchNodeByFileIndex.get(fileIndex)
        if (patchNode) scrollPatchNodeToTop(patchNode)
        setPendingPatchScrollFileIndex(undefined)
      })
    })
  }

  const scrollSinglePatchToTop = () => {
    requestAnimationFrame(() => {
      scroll?.scrollTo(0)
      requestAnimationFrame(() => scroll?.scrollTo(0))
    })
  }

  const measurePatchFiller = () => {
    requestAnimationFrame(() => {
      if (!scroll) return
      const entries = visiblePatchFiles()
        .map((entry) => patchNodeByFileIndex.get(entry.fileIndex))
        .filter((node): node is BoxRenderable => Boolean(node))
      if (entries.length === 0) {
        setPatchFillerHeight(0)
        return
      }
      const contentHeight = Math.max(
        ...entries.map((node) => scroll!.scrollTop + node.y - scroll!.viewport.y + node.height),
      )
      setPatchFillerHeight(Math.max(0, scroll.viewport.height - contentHeight))
    })
  }

  const registerPatchNode = (fileIndex: number, element: BoxRenderable) => {
    patchNodeByFileIndex.set(fileIndex, element)
    measurePatchFiller()
    if (pendingPatchScrollFileIndex() !== fileIndex) return
    requestAnimationFrame(() => {
      scrollPatchNodeToTop(element)
      requestAnimationFrame(() => {
        scrollPatchNodeToTop(element)
        setPendingPatchScrollFileIndex(undefined)
      })
    })
  }

  createEffect(() => {
    visiblePatchFiles()
    dimensions()
    view()
    measurePatchFiller()
  })

  const toggleSelectedFileTreeRow = () => {
    const highlighted = fileRows().find((row) => row.id === highlightedFileNode())
    if (highlighted?.fileIndex !== undefined) {
      jumpToFileIndex(highlighted.fileIndex)
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, highlightedFileNode()))
  }

  const clickFileTreeRow = (row: FileTreeRow) => {
    setFocus("files")
    setHighlighted(row.id)
    if (row.fileIndex !== undefined) {
      jumpToFileIndex(row.fileIndex)
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, row.id))
  }

  const toggleSelectedFileReviewed = () => {
    const fileIndex =
      focus() === "files"
        ? fileRows().find((row) => row.id === highlightedFileNode())?.fileIndex
        : (selectedFileIndex() ?? activePatchFileIndex() ?? currentPatchFileIndex())
    const file = fileIndex === undefined ? undefined : files()[fileIndex]?.file
    if (!file) return
    setReviewedFileNames((reviewed) => {
      const next = new Set(reviewed)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  const close = () => {
    const returnRoute = params()?.returnRoute
    dialog.clear()
    props.context.ui.router.navigate(returnRoute ?? { type: "home" })
  }

  const commands: KeymapCommand[] = [
    {
      id: "diff.close",
      title: i18n.t("feature.diff.command.close"),
      group: i18n.t("feature.diff.group"),
      run: close,
    },
    {
      id: "diff.down",
      title: i18n.t("feature.diff.command.down"),
      group: i18n.t("feature.diff.group"),
      run: focusRunner({
        files() {
          moveFileSelection(1)
        },
        patches() {
          clearFileTreePatchState()
          scroll?.scrollBy(1)
        },
      }),
    },
    {
      id: "diff.up",
      title: i18n.t("feature.diff.command.up"),
      group: i18n.t("feature.diff.group"),
      run: focusRunner({
        files() {
          moveFileSelection(-1)
        },
        patches() {
          clearFileTreePatchState()
          scroll?.scrollBy(-1)
        },
      }),
    },
    {
      id: "diff.page.down",
      title: i18n.t("feature.diff.command.pageDown"),
      group: i18n.t("feature.diff.group"),
      run: focusRunner({
        files() {
          moveFileSelection(8)
        },
        patches() {
          clearFileTreePatchState()
          if (scroll) scroll.scrollBy(scroll.height)
        },
      }),
    },
    {
      id: "diff.page.up",
      title: i18n.t("feature.diff.command.pageUp"),
      group: i18n.t("feature.diff.group"),
      run: focusRunner({
        files() {
          moveFileSelection(-8)
        },
        patches() {
          clearFileTreePatchState()
          if (scroll) scroll.scrollBy(-scroll.height)
        },
      }),
    },
    {
      id: "diff.toggle",
      title: i18n.t("feature.diff.command.toggle"),
      group: i18n.t("feature.diff.group"),
      run: focusRunner({
        files() {
          toggleSelectedFileTreeRow()
        },
        patches() {},
      }),
    },
    {
      id: "diff.expand",
      title: i18n.t("feature.diff.command.expand"),
      group: i18n.t("feature.diff.group"),
      run: focusRunner({
        files() {
          const highlighted = highlightedFileNode()
          if (highlighted !== undefined && expandedFileNodes().has(highlighted)) {
            setHighlighted(moveFileTreeSelectionToFirstChild(fileRows(), highlighted))
            return
          }
          setExpandedFileNodes((expanded) =>
            setFileTreeDirectoryExpanded(fileTree(), expanded, highlightedFileNode(), true),
          )
        },
        patches() {},
      }),
    },
    {
      id: "diff.expand_all",
      title: i18n.t("feature.diff.command.expandAll"),
      group: i18n.t("feature.diff.group"),
      run: focusRunner({
        files() {
          setExpandedFileNodes(allExpandedFileTreeDirectories(fileTree()))
        },
        patches() {},
      }),
    },
    {
      id: "diff.collapse",
      title: i18n.t("feature.diff.command.collapse"),
      group: i18n.t("feature.diff.group"),
      run: focusRunner({
        files() {
          const highlighted = highlightedFileNode()
          const node = highlighted === undefined ? undefined : fileTree().nodes[highlighted]
          if (node?.kind !== "directory" || !expandedFileNodes().has(node.id)) {
            setHighlighted(moveFileTreeSelectionToParent(fileRows(), highlighted))
            return
          }
          setExpandedFileNodes((expanded) =>
            setFileTreeDirectoryExpanded(fileTree(), expanded, highlightedFileNode(), false),
          )
        },
        patches() {},
      }),
    },
    {
      id: "diff.next_hunk",
      title: i18n.t("feature.diff.command.nextHunk"),
      group: i18n.t("feature.diff.group"),
      run() {
        jumpRelativeHunk(1)
      },
    },
    {
      id: "diff.previous_hunk",
      title: i18n.t("feature.diff.command.previousHunk"),
      group: i18n.t("feature.diff.group"),
      run() {
        jumpRelativeHunk(-1)
      },
    },
    {
      id: "diff.next_file",
      title: i18n.t("feature.diff.command.nextFile"),
      group: i18n.t("feature.diff.group"),
      run() {
        jumpRelativePatchFile(1)
      },
    },
    {
      id: "diff.previous_file",
      title: i18n.t("feature.diff.command.previousFile"),
      group: i18n.t("feature.diff.group"),
      run() {
        jumpRelativePatchFile(-1)
      },
    },
    {
      id: "diff.mark_reviewed",
      title: i18n.t("feature.diff.command.markReviewed"),
      group: i18n.t("feature.diff.group"),
      run() {
        toggleSelectedFileReviewed()
      },
    },
    {
      id: "diff.switch_focus",
      title: i18n.t("feature.diff.command.switchFocus"),
      group: i18n.t("feature.diff.group"),
      run() {
        if (!showFileTree()) return
        setFocus((current) => {
          if (current === "files") return "patches"
          ensureHighlightedFileNode()
          return "files"
        })
      },
    },
    {
      id: "diff.toggle_file_tree",
      title: i18n.t("feature.diff.command.toggleFileTree"),
      group: i18n.t("feature.diff.group"),
      run() {
        const next = !fileTreeEnabled()
        if (!next) setFocus("patches")
        setFileTreeEnabled(next)
        void config
          .update((draft) => {
            draft.diffs = { ...draft.diffs, tree: next }
          })
          .catch(() => {})
      },
    },
    {
      id: "diff.single_patch",
      title: i18n.t("feature.diff.command.singlePatch"),
      group: i18n.t("feature.diff.group"),
      run() {
        setSelectedHunk(undefined)
        if (!singlePatch()) {
          ensureHighlightedPatchFile()
          setSinglePatch(true)
          void config
            .update((draft) => {
              draft.diffs = { ...draft.diffs, single: true }
            })
            .catch(() => {})
          scrollSinglePatchToTop()
          return
        }
        const fileIndex =
          visiblePatchFiles()[0]?.fileIndex ??
          singlePatchFileIndex(
            selectedFileIndex(),
            activePatchFileIndex(),
            currentPatchFileIndex(),
            firstPatchFileIndex(),
          )
        if (fileIndex !== undefined) selectPatchFile(fileIndex)
        setSinglePatch(false)
        void config
          .update((draft) => {
            draft.diffs = { ...draft.diffs, single: false }
          })
          .catch(() => {})
        if (fileIndex !== undefined) scrollToPatchFileIndexAfterRender(fileIndex)
      },
    },
    {
      id: "diff.switch_source",
      title: i18n.t("feature.diff.command.switchSource"),
      group: i18n.t("feature.diff.group"),
      run() {
        openSwitchDiffDialog()
      },
    },
    {
      id: "diff.toggle_view",
      title: i18n.t("feature.diff.command.toggleView"),
      group: i18n.t("feature.diff.group"),
      run() {
        if (!splitAvailable()) return
        setSelectedHunk(undefined)
        const next = view() === "split" ? "unified" : "split"
        setViewOverride(next)
        void config
          .update((draft) => {
            draft.diffs = { ...draft.diffs, view: next }
          })
          .catch(() => {})
      },
    },
    {
      id: "diff.help",
      title: i18n.t("feature.diff.command.help"),
      group: i18n.t("feature.diff.group"),
      run() {
        openHelpDialog()
      },
    },
  ]

  const switchDiffOptions = createMemo(() => {
    return [
      {
        title: i18n.t("feature.diff.sourceOption.working.title"),
        value: "working" as const,
        description: i18n.t("feature.diff.sourceOption.working.description"),
      },
      {
        title: i18n.t("feature.diff.sourceOption.branch.title"),
        value: "branch" as const,
        description: i18n.t("feature.diff.sourceOption.branch.description"),
      },
    ]
  })

  const openSwitchDiffDialog = () => {
    dialog.show(() => (
      <DialogSelect
        title={i18n.t("feature.diff.sourceDialog.title")}
        skipFilter={true}
        renderFilter={false}
        current={mode()}
        options={switchDiffOptions().map((option) => ({
          ...option,
          onSelect() {
            dialog.clear()
            props.context.ui.router.navigate({
              type: "plugin",
              name: ROUTE,
              data: {
                mode: option.value,
                sessionID: params()?.sessionID,
                returnRoute: params()?.returnRoute,
              },
            })
          },
        }))}
      />
    ))
  }

  const openHelpDialog = () => {
    dialog.show(() => <DiffViewerHelpDialog context={props.context} />)
    dialog.set({ size: "large" })
  }

  props.context.keymap.layer(() => ({
    commands,
  }))

  return (
    <box position="absolute" zIndex={2500} left={0} top={0} width={dimensions().width} height={dimensions().height}>
      <PanelGroup axis="y" context={props.context} width="100%" height="100%">
        <Panel border="none" flexShrink={0} padding={0} paddingLeft={1}>
          <text fg={theme.text.default}>{i18n.t("feature.diff.title", { source: diffSourceLabel(mode(), i18n.t) })}</text>
          <box flexGrow={1} />
          <Show when={!diff.loading && !diff.error}>
            <text fg={theme.text.subdued}>
              {i18n.t(files().length === 1 ? "feature.diff.fileCount.one" : "feature.diff.fileCount.other", {
                count: files().length,
              })}
            </text>
          </Show>
        </Panel>

        <box flexGrow={1} minHeight={0}>
          <Switch>
            <Match when={diff.loading}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme.text.subdued}>{i18n.t("feature.diff.loading")}</text>
              </box>
            </Match>
            <Match when={!diff.loading && diff.error}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme.text.feedback.error.default}>
                  {i18n.t("feature.diff.loadError")}
                </text>
              </box>
            </Match>
            <Match when={!diff.loading && files().length === 0}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme.text.subdued}>{i18n.t("feature.diff.noChanges")}</text>
              </box>
            </Match>
            <Match when={!diff.loading}>
              <PanelGroup axis="x" context={props.context}>
                <Show when={showFileTree()}>
                  <DiffViewerFileTree
                    context={props.context}
                    files={files()}
                    loading={diff.loading}
                    error={diff.error}
                    focused={focus() === "files"}
                    width={FILE_TREE_WIDTH}
                    highlightedNode={highlightedFileNode()}
                    selectedFileIndex={selectedFileIndex()}
                    reviewedFileNames={reviewedFileNames()}
                    expandedNodes={expandedFileNodes()}
                    onRowClick={clickFileTreeRow}
                  />
                </Show>

                <Panel flexGrow={1} minHeight={0} border="none">
                  <Separator axis="x" start={showFileTree() ? "edge-out" : undefined} />
                  <scrollbox
                    ref={(element: ScrollBoxRenderable) => (scroll = element)}
                    flexGrow={1}
                    minHeight={0}
                    scrollAcceleration={patchScrollAcceleration()}
                    verticalScrollbarOptions={{ visible: false }}
                    horizontalScrollbarOptions={{ visible: false }}
                  >
                    <For each={visiblePatchFiles()}>
                      {(entry, index) => {
                        const reviewed = () => reviewedFileNames().has(entry.file.file)
                        return (
                          <box ref={(element: BoxRenderable) => registerPatchNode(entry.fileIndex, element)}>
                            {index() !== 0 ? <Separator axis="x" start={showFileTree() ? "edge" : undefined} /> : null}
                            <box
                              flexDirection="row"
                              gap={1}
                              flexShrink={0}
                              paddingLeft={1}
                              paddingRight={1}
                              border={patchLeftBorder()}
                              borderColor={theme.border.default}
                            >
                              <text fg={reviewed() ? theme.text.subdued : theme.text.default}>{entry.file.file}</text>
                              <box flexGrow={1} />
                              <text fg={reviewed() ? theme.text.subdued : theme.diff.text.added}>
                                +{entry.file.additions}
                              </text>
                              <text fg={reviewed() ? theme.text.subdued : theme.diff.text.removed}>
                                -{entry.file.deletions}
                              </text>
                            </box>
                            <Separator axis="x" start={showFileTree() ? "edge" : undefined} />
                            <Show
                              when={entry.file.patch}
                              fallback={<text fg={theme.text.subdued}>{i18n.t("feature.diff.noPatch")}</text>}
                            >
                              {(patch) => (
                                <box border={patchLeftBorder()} borderColor={theme.border.default}>
                                  <PatchDiff
                                    ref={(component) => patchDiffByFileIndex.set(entry.fileIndex, component)}
                                    diff={patch()}
                                    hunkFg={reviewed() ? theme.text.subdued : theme.diff.text.hunkHeader}
                                    view={view()}
                                    filetype={reviewed() ? PLAIN_TEXT_FILETYPE : filetype(entry.file.file)}
                                    syntaxStyle={currentSyntax()}
                                    showLineNumbers={true}
                                    width="100%"
                                    wrapMode="char"
                                    fg={reviewed() ? theme.text.subdued : theme.text.default}
                                    addedBg={
                                      reviewed() ? theme.background.surface.overlay : theme.diff.background.added
                                    }
                                    removedBg={
                                      reviewed() ? theme.background.surface.overlay : theme.diff.background.removed
                                    }
                                    contextBg={
                                      reviewed() ? theme.background.surface.overlay : theme.diff.background.context
                                    }
                                    addedSignColor={reviewed() ? theme.text.subdued : theme.diff.highlight.added}
                                    removedSignColor={reviewed() ? theme.text.subdued : theme.diff.highlight.removed}
                                    lineNumberFg={theme.diff.lineNumber.text}
                                    lineNumberBg={
                                      reviewed() ? theme.background.surface.overlay : theme.diff.background.context
                                    }
                                    addedLineNumberBg={
                                      reviewed()
                                        ? theme.background.surface.overlay
                                        : theme.diff.lineNumber.background.added
                                    }
                                    removedLineNumberBg={
                                      reviewed()
                                        ? theme.background.surface.overlay
                                        : theme.diff.lineNumber.background.removed
                                    }
                                  />
                                </box>
                              )}
                            </Show>
                          </box>
                        )
                      }}
                    </For>
                    <Show when={patchFillerHeight() > 0}>
                      <box height={patchFillerHeight()} border={patchLeftBorder()} borderColor={theme.border.default} />
                    </Show>
                  </scrollbox>
                  <Separator axis="x" start={showFileTree() ? "edge-in" : undefined} />
                </Panel>
              </PanelGroup>
            </Match>
          </Switch>
        </box>

        <Panel flexShrink={0} gap={2} paddingLeft={1} border="none">
          <Show when={switchFocusShortcut()}>
            {(shortcut) => (
              <text fg={theme.text.default}>
                {shortcut()} <span style={{ fg: theme.text.subdued }}>{i18n.t("feature.diff.hint.focusFileTree")}</span>
              </text>
            )}
          </Show>
          <Show when={nextFileShortcut()}>
            {(shortcut) => (
              <text fg={theme.text.default}>
                {shortcut()} <span style={{ fg: theme.text.subdued }}>{i18n.t("feature.diff.hint.nextFile")}</span>
              </text>
            )}
          </Show>
          <Show when={nextHunkShortcut()}>
            {(shortcut) => (
              <text fg={theme.text.default}>
                {shortcut()} <span style={{ fg: theme.text.subdued }}>{i18n.t("feature.diff.hint.nextHunk")}</span>
              </text>
            )}
          </Show>
          <Show when={previousHunkShortcut()}>
            {(shortcut) => (
              <text fg={theme.text.default}>
                {shortcut()} <span style={{ fg: theme.text.subdued }}>{i18n.t("feature.diff.hint.previousHunk")}</span>
              </text>
            )}
          </Show>
          <Show when={previousFileShortcut()}>
            {(shortcut) => (
              <text fg={theme.text.default}>
                {shortcut()} <span style={{ fg: theme.text.subdued }}>{i18n.t("feature.diff.hint.previousFile")}</span>
              </text>
            )}
          </Show>
          <Show when={switchSourceShortcut()}>
            {(shortcut) => (
              <text fg={theme.text.default}>
                {shortcut()} <span style={{ fg: theme.text.subdued }}>{i18n.t("feature.diff.hint.switchSource")}</span>
              </text>
            )}
          </Show>
          <Show when={markReviewedShortcut()}>
            {(shortcut) => (
              <text fg={theme.text.default}>
                {shortcut()} <span style={{ fg: theme.text.subdued }}>{i18n.t("feature.diff.hint.markReviewed")}</span>
              </text>
            )}
          </Show>
          <Show when={helpShortcut()}>
            {(shortcut) => (
              <text fg={theme.text.default}>
                {shortcut()} <span style={{ fg: theme.text.subdued }}>{i18n.t("feature.diff.hint.all")}</span>
              </text>
            )}
          </Show>
        </Panel>
      </PanelGroup>
    </box>
  )
}

function DiffViewerHelpDialog(props: { context: Plugin.Context }) {
  const i18n = useI18n()
  const theme = props.context.theme.contextual.elevated
  const shortcut = (id: string) => () => props.context.keymap.shortcuts(id)[0]
  const rows = [
    {
      shortcut: () => "q",
      action: i18n.t("feature.diff.help.close.action"),
      description: i18n.t("feature.diff.help.close.description"),
    },
    {
      shortcut: shortcut("diff.switch_focus"),
      action: i18n.t("feature.diff.help.focusFileTree.action"),
      description: i18n.t("feature.diff.help.focusFileTree.description"),
    },
    {
      shortcut: shortcut("diff.next_hunk"),
      action: i18n.t("feature.diff.help.nextHunk.action"),
      description: i18n.t("feature.diff.help.nextHunk.description"),
    },
    {
      shortcut: shortcut("diff.previous_hunk"),
      action: i18n.t("feature.diff.help.previousHunk.action"),
      description: i18n.t("feature.diff.help.previousHunk.description"),
    },
    {
      shortcut: shortcut("diff.next_file"),
      action: i18n.t("feature.diff.help.nextFile.action"),
      description: i18n.t("feature.diff.help.nextFile.description"),
    },
    {
      shortcut: shortcut("diff.previous_file"),
      action: i18n.t("feature.diff.help.previousFile.action"),
      description: i18n.t("feature.diff.help.previousFile.description"),
    },
    {
      shortcut: shortcut("diff.toggle_file_tree"),
      action: i18n.t("feature.diff.help.toggleFileTree.action"),
      description: i18n.t("feature.diff.help.toggleFileTree.description"),
    },
    {
      shortcut: shortcut("diff.single_patch"),
      action: i18n.t("feature.diff.help.singlePatch.action"),
      description: i18n.t("feature.diff.help.singlePatch.description"),
    },
    {
      shortcut: shortcut("diff.switch_source"),
      action: i18n.t("feature.diff.help.switchSource.action"),
      description: i18n.t("feature.diff.help.switchSource.description"),
    },
    {
      shortcut: shortcut("diff.toggle_view"),
      action: i18n.t("feature.diff.help.toggleView.action"),
      description: i18n.t("feature.diff.help.toggleView.description"),
    },
    {
      shortcut: shortcut("diff.expand_all"),
      action: i18n.t("feature.diff.help.expandAll.action"),
      description: i18n.t("feature.diff.help.expandAll.description"),
    },
    {
      shortcut: shortcut("diff.mark_reviewed"),
      action: i18n.t("feature.diff.help.markReviewed.action"),
      description: i18n.t("feature.diff.help.markReviewed.description"),
    },
  ]

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.default}>
          {i18n.t("feature.diff.help.title")}
        </text>
        <text fg={theme.text.subdued}>esc</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.text.subdued} width={5} wrapMode="none">
          {i18n.t("feature.diff.help.key")}
        </text>
        <text fg={theme.text.subdued} width={22} wrapMode="none">
          {i18n.t("feature.diff.help.action")}
        </text>
        <text fg={theme.text.subdued}>{i18n.t("feature.diff.help.description")}</text>
      </box>
      <For each={rows}>
        {(row) => (
          <box flexDirection="row">
            <text fg={theme.text.default} width={5} wrapMode="none">
              {row.shortcut() || "-"}
            </text>
            <text fg={theme.text.default} width={22} wrapMode="none">
              {row.action}
            </text>
            <text fg={theme.text.subdued}>{row.description}</text>
          </box>
        )}
      </For>
    </box>
  )
}

function Commands(props: { context: Plugin.Context }) {
  const i18n = useI18n()
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "diff.open",
        title: i18n.t("feature.diff.command.open"),
        slash: { name: "diff" },
        group: i18n.t("feature.diff.group"),
        palette: true,
        run() {
          const route = props.context.ui.router.current()
          const returnRoute: Route =
            route.type === "home"
              ? { type: "home" }
              : route.type === "session"
                ? { type: "session", sessionID: route.sessionID }
                : {
                    type: "plugin",
                    id: route.id,
                    name: route.name,
                    ...(route.data ? { data: { ...route.data } } : {}),
                  }
          props.context.ui.router.navigate({
            type: "plugin",
            name: ROUTE,
            data: {
              mode: "working",
              sessionID: route.type === "session" ? route.sessionID : undefined,
              returnRoute,
            },
          })
          props.context.ui.dialog.clear()
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "diff-viewer",
  setup(context) {
    context.ui.router.register({
      name: ROUTE,
      render: () => <DiffViewer context={context} />,
    })
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
