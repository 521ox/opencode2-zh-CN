import { isRecord } from "./record"
import { translate, type Translator } from "../i18n"

const englishTranslator: Translator = (key, params) => translate("en", key, params)

type ConfigIssue = { message: string; path: string[] }

export function cliErrorMessage(input: unknown, t: Translator = englishTranslator): string | undefined {
  if (input instanceof Error && isRecord(input.cause) && "body" in input.cause) {
    const formatted = cliErrorMessage(input.cause.body, t)
    if (formatted) return formatted
  }

  if (tagged(input, "CliError")) {
    if (typeof input.exitCode === "number") process.exitCode = input.exitCode
    return field(input, "message") ?? ""
  }
  if (tagged(input, "AccountServiceError") || tagged(input, "AccountTransportError")) {
    return field(input, "message") ?? ""
  }

  const model = configData(input, "ProviderModelNotFoundError")
  if (model) {
    const suggestions = Array.isArray(model.suggestions)
      ? model.suggestions.filter((item): item is string => typeof item === "string")
      : []
    return [
      t("common.error.modelNotFound", {
        providerID: field(model, "providerID") ?? "",
        modelID: field(model, "modelID") ?? "",
      }),
      ...(suggestions.length ? [t("common.error.didYouMean", { suggestions: suggestions.join(", ") })] : []),
      t("common.error.listModels"),
      t("common.error.checkModelConfig"),
    ].join("\n")
  }

  const provider = configData(input, "ProviderInitError")
  if (provider) return t("common.error.providerInit", { providerID: field(provider, "providerID") ?? "" })

  const json = configData(input, "ConfigJsonError")
  if (json) {
    const message = field(json, "message")
    return t("common.error.configJson", { path: field(json, "path") ?? "" }) + (message ? `: ${message}` : "")
  }

  const directory = configData(input, "ConfigDirectoryTypoError")
  if (directory) {
    return t("common.error.configDirectoryTypo", {
      directory: field(directory, "dir") ?? "",
      path: field(directory, "path") ?? "",
      suggestion: field(directory, "suggestion") ?? "",
    })
  }

  const frontmatter = configData(input, "ConfigFrontmatterError")
  if (frontmatter) return field(frontmatter, "message") ?? ""

  const invalid = configData(input, "ConfigInvalidError")
  if (invalid) {
    const path = field(invalid, "path")
    const message = field(invalid, "message")
    const issues = Array.isArray(invalid.issues)
      ? invalid.issues.filter((issue): issue is ConfigIssue => {
          return (
            isRecord(issue) &&
            typeof issue.message === "string" &&
            Array.isArray(issue.path) &&
            issue.path.every((item) => typeof item === "string")
          )
        })
      : []
    return [
      (path && path !== "config" ? t("common.error.configInvalidAt", { path }) : t("common.error.configInvalid")) +
        (message ? `: ${message}` : ""),
      ...issues.map((issue) => "↳ " + issue.message + " " + issue.path.join(".")),
    ].join("\n")
  }

  if (tagged(input, "UICancelledError") || named(input, "UICancelledError")) return ""
  if (isRecord(input) && named(input, "MCPFailed")) {
    const name = isRecord(input.data) ? field(input.data, "name") : undefined
    return t("common.error.mcpFailed", { name: name ?? "" })
  }
  return undefined
}

function tagged(input: unknown, tag: string): input is Record<string, unknown> {
  return isRecord(input) && input._tag === tag
}

function named(input: unknown, name: string) {
  return isRecord(input) && (input.name === name || input._tag === name)
}

function configData(input: unknown, tag: string) {
  if (!isRecord(input)) return undefined
  if (input.name === tag && isRecord(input.data)) return input.data
  if (input._tag === tag) return input
  return undefined
}

function field(input: Record<string, unknown>, key: string) {
  return typeof input[key] === "string" ? input[key] : undefined
}

export function errorFormat(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }

  if (typeof error === "object" && error !== null) {
    try {
      const json = JSON.stringify(error, null, 2)
      // Plain objects whose own properties are all non-enumerable (or empty)
      // serialize to "{}", which prints as a useless bare `{}` on stderr.
      // Fall back to a custom toString first, then to ctor name + own prop names.
      if (json === "{}") {
        const str = String(error)
        if (str && str !== "[object Object]") return str
        const ctor = error.constructor?.name
        const prefix = ctor && ctor !== "Object" ? ctor : "Error"
        const names = Object.getOwnPropertyNames(error)
        return names.length === 0 ? `${prefix} (no message)` : `${prefix} { ${names.join(", ")} }`
      }
      return json
    } catch {
      return "Unexpected error (unserializable)"
    }
  }

  return String(error)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message) return error.message
    if (error.name) return error.name
  }

  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return error.message
  }

  if (isRecord(error) && isRecord(error.data) && typeof error.data.message === "string" && error.data.message) {
    return error.data.message
  }

  const text = String(error)
  if (text && text !== "[object Object]") return text

  const formatted = errorFormat(error)
  if (formatted) return formatted
  return "unknown error"
}
