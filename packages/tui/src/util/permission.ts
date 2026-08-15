import { Locale } from "./locale"
import { canonicalToolName, finiteNumber, webSearchProviderLabel } from "./tool-display"
import { translate, type Translator } from "../i18n"

const englishTranslator: Translator = (key, params) => translate("en", key, params)

type Dict = Record<string, unknown>

export type PermissionPresentation = {
  icon: string
  title: string
  lines: string[]
  diff?: string
  patch?: string
  file?: string
}

export type PermissionPresentationInput = {
  action: string
  resources: ReadonlyArray<unknown>
  metadata?: unknown
  input?: unknown
  toolMetadata?: unknown
}

export function permissionPresentation(
  source: PermissionPresentationInput,
  formatPath: (value: string) => string = (value) => value,
  t: Translator = englishTranslator,
): PermissionPresentation {
  const action = canonicalToolName(source.action)
  const input = normalizeInput(action, source.input)
  const metadata = { ...dict(source.toolMetadata), ...dict(source.metadata) }
  const resources = source.resources.filter((item): item is string => typeof item === "string")

  if (action === "edit") {
    const file = text(input.path) || resources[0] || ""
    const first = dict(Array.isArray(metadata.files) ? metadata.files[0] : undefined)
    const diff = text(first.patch) || text(first.diff) || text(metadata.diff) || undefined
    return {
      icon: "→",
      title: t("common.permission.info.edit", { path: formatPath(file) }),
      lines: [],
      diff,
      patch: diff ? undefined : text(input.patchText) || undefined,
      file,
    }
  }

  if (action === "read" || action === "list") {
    const value = text(input.path) || resources[0] || ""
    return {
      icon: "→",
      title: t(action === "read" ? "common.permission.info.read" : "common.permission.info.list", {
        path: formatPath(value),
      }),
      lines: value ? [t("common.permission.info.path", { path: formatPath(value) })] : [],
    }
  }

  if (action === "glob" || action === "grep") {
    const pattern = text(input.pattern) || resources[0] || ""
    return {
      icon: "✱",
      title: t(action === "glob" ? "common.permission.info.glob" : "common.permission.info.grep", { pattern }),
      lines: pattern ? [t("common.permission.info.pattern", { pattern })] : [],
    }
  }

  if (action === "shell") {
    const command = text(input.command)
    return {
      icon: "#",
      title: t("common.permission.info.shellCommand"),
      lines: command ? [`$ ${command}`] : resources.map((item) => `- ${item}`),
    }
  }

  if (action === "subagent") {
    const agent = text(input.agent) || "general"
    const description = text(input.description)
    return {
      icon: "#",
      title: t("common.permission.info.subagent", { agent: Locale.titlecase(agent) }),
      lines: description ? [`◉ ${description}`] : [],
    }
  }

  if (action === "webfetch") {
    const url = text(input.url) || text(metadata.url)
    return {
      icon: "%",
      title: t("common.permission.info.webfetch", { url }).trim(),
      lines: url ? [t("common.permission.info.url", { url })] : [],
    }
  }

  if (action === "websearch") {
    const query = text(input.query) || text(metadata.query)
    const title = webSearchProviderLabel(metadata.provider, t)
    return {
      icon: "◈",
      title: query
        ? t("common.permission.info.websearch", { provider: title, query })
        : t("common.permission.info.websearchProvider", { provider: title }),
      lines: query ? [t("common.permission.info.query", { query })] : [],
    }
  }

  if (action === "lsp") {
    const file = text(input.path)
    const operation = text(input.operation) || "request"
    const line = finiteNumber(input.line)
    const character = finiteNumber(input.character)
    const position = line !== undefined && character !== undefined ? `${line}:${character}` : undefined
    const path = file ? `${formatPath(file)}${position ? `:${position}` : ""}` : undefined
    return {
      icon: "→",
      title: path
        ? t("common.permission.info.lspFile", { operation, file: path })
        : t("common.permission.info.lsp", { operation }),
      lines: [
        ...(input.operation ? [t("common.permission.info.operation", { operation })] : []),
        ...(file ? [t("common.permission.info.path", { path: formatPath(file) })] : []),
        ...(position ? [t("common.permission.info.position", { position })] : []),
      ],
    }
  }

  if (action === "external_directory") {
    const raw = text(metadata.parentDir) || text(metadata.filepath) || resources[0] || ""
    const directory = wildcardDirectory(raw)
    return {
      icon: "←",
      title: t("common.permission.info.externalDirectory", { directory: formatPath(directory) }),
      lines: resources.map((item) => `- ${item}`),
    }
  }

  if (action === "doom_loop") {
    return {
      icon: "⟳",
      title: t("common.permission.info.doom"),
      lines: [t("common.permission.info.doomLine")],
    }
  }

  return {
    icon: "⚙",
    title: t("common.permission.info.callTool", { tool: source.action }),
    lines: [t("common.permission.info.tool", { tool: source.action })],
  }
}

function wildcardDirectory(value: string) {
  const wildcard = value.indexOf("*")
  if (wildcard === -1) return value
  const prefix = value.slice(0, wildcard)
  if (/^[\\/]+$/.test(prefix) || /^[A-Za-z]:[\\/]$/.test(prefix)) return prefix
  return prefix.replace(/[\\/]+$/, "")
}

function normalizeInput(action: string, value: unknown): Dict {
  const input = dict(value)
  const path = text(input.path) || text(input.filePath) || text(input.filepath)
  const agent = text(input.agent) || text(input.subagent_type)
  return {
    ...input,
    ...(["read", "edit", "list", "lsp"].includes(action) && path ? { path } : {}),
    ...(action === "subagent" && agent ? { agent } : {}),
  }
}

function dict(value: unknown): Dict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Dict
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}
