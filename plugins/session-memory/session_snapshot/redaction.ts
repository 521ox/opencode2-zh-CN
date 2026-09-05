import type { RedactionResult, RedactionStatus } from "./types"

type Rule = {
  category: string
  pattern: RegExp
}

export type UnsupportedTextInspection = {
  failureClasses: string[]
  nulCount: number
  controlCount: number
  textLength: number
}

const RULES: Rule[] = [
  {
    category: "private-key",
    pattern: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
  },
  { category: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { category: "authorization-header", pattern: /\b(?:Authorization|Proxy-Authorization)\s*:\s*[^\r\n]+/gi },
  { category: "cookie-header", pattern: /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi },
  { category: "token-header", pattern: /\b(?:X-API-Key|X-Auth-Token|X-Access-Token)\s*:\s*[^\r\n]+/gi },
  { category: "openai-style-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { category: "github-token", pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g },
  { category: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { category: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    category: "uri-credential",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi,
  },
  {
    category: "sensitive-query-parameter",
    pattern:
      /([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|key|secret|password|passwd|signature|sig|credential|auth)=)[^&#\s"']+/gi,
  },
]

const ANSI_RULES: Rule[] = [
  { category: "ansi-control-sequence", pattern: /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g },
  { category: "ansi-control-sequence", pattern: /\u001B\[[0-?]*[ -/]*[@-~]/g },
  { category: "ansi-control-sequence", pattern: /\u001B[@-_]/g },
]

const CREDENTIAL_ASSIGNMENT =
  /(["']?)([A-Za-z][A-Za-z0-9_.-]{0,127})\1\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}\]&#]+)/g

const UNSUPPORTED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/
const HEADER_RULE_HINT = /Bearer|Authorization|Cookie|X-API-Key|X-Auth-Token|X-Access-Token/i
const CREDENTIAL_KEY_HINT = /password|passwd|secret|credential|authorization|cookie|token|auth|key/i

function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function isSensitiveKey(key: string): boolean {
  const tokens = keyTokens(key)
  if (tokens.length === 0) return false
  if (tokens.some((token) => ["password", "passwd", "secret", "credential"].includes(token))) return true
  if (tokens.includes("authorization")) return true

  const last = tokens.at(-1)
  if (last === "token" || last === "auth" || last === "cookie") return true
  if (
    last === "key" &&
    tokens.some((token) => ["api", "access", "auth", "private", "signing", "encryption"].includes(token))
  ) {
    return true
  }

  const compact = tokens.join("")
  return [
    /(?:api|auth|private|signing|encryption|secretaccess)key$/,
    /token$/,
    /(?:client)?secret(?:value)?$/,
    /password(?:value|hash)?$/,
    /passwd$/,
    /credential$/,
    /authorization(?:header)?$/,
    /cookie$/,
  ].some((pattern) => pattern.test(compact))
}

function redactCredentialAssignments(input: string): { text: string; redactedCount: number } {
  let redactedCount = 0
  const text = input.replace(CREDENTIAL_ASSIGNMENT, (match, _quote: string, key: string) => {
    if (!isSensitiveKey(key)) return match
    redactedCount++
    return "[REDACTED:credential-assignment]"
  })
  return { text, redactedCount }
}

function inspectControlContent(input: string): UnsupportedTextInspection {
  const failures: string[] = []
  let nulCount = 0
  let controls = 0
  if (UNSUPPORTED_CONTROL.test(input)) {
    for (const char of input) {
      const code = char.charCodeAt(0)
      if (code === 0) nulCount++
      if (code < 32 && char !== "\n" && char !== "\r" && char !== "\t") controls++
    }
  }
  if (nulCount > 0) failures.push("nul-byte")
  if (input.length > 0 && controls / input.length > 0.01) failures.push("binary-like-control-content")
  return {
    failureClasses: failures,
    nulCount,
    controlCount: controls,
    textLength: input.length,
  }
}

export function inspectUnsupportedText(input: string): UnsupportedTextInspection {
  let text = input
  if (text.includes("\u001B")) {
    for (const rule of ANSI_RULES) text = text.replace(rule.pattern, "")
  }
  return inspectControlContent(text)
}

export function redactText(input: string): RedactionResult {
  const categories = new Set<string>()
  let redactedCount = 0
  let text = input

  if (text.includes("\u001B")) {
    for (const rule of ANSI_RULES) {
      text = text.replace(rule.pattern, () => {
        redactedCount++
        categories.add(rule.category)
        return ""
      })
    }
  }

  const inspection = inspectControlContent(text)
  const failureClasses = inspection.failureClasses

  const privateKeyHint = text.includes("PRIVATE KEY")
  const headerHint = HEADER_RULE_HINT.test(text)
  const openAIHint = text.includes("sk-")
  const githubHint = /gh[pousr]_/.test(text)
  const awsHint = text.includes("AKIA") || text.includes("ASIA")
  const jwtHint = text.includes("eyJ")
  const uriHint = text.includes("://")
  const queryHint = text.includes("?") || text.includes("&")
  const applyRule = (rule: Rule) => {
    text = text.replace(rule.pattern, (match, prefix?: string) => {
      redactedCount++
      categories.add(rule.category)
      if (rule.category === "uri-credential" && typeof prefix === "string") {
        return `${prefix}[REDACTED-${rule.category}]@`
      }
      return `[REDACTED:${rule.category}]`
    })
  }
  if (privateKeyHint) applyRule(RULES[0])
  if (headerHint) {
    applyRule(RULES[1])
    applyRule(RULES[2])
    applyRule(RULES[3])
    applyRule(RULES[4])
  }
  if (openAIHint) applyRule(RULES[5])
  if (githubHint) applyRule(RULES[6])
  if (awsHint) applyRule(RULES[7])
  if (jwtHint) applyRule(RULES[8])
  if (uriHint) applyRule(RULES[9])
  if (queryHint) applyRule(RULES[10])

  if ((text.includes(":") || text.includes("=")) && CREDENTIAL_KEY_HINT.test(text)) {
    const assignments = redactCredentialAssignments(text)
    text = assignments.text
    if (assignments.redactedCount > 0) {
      redactedCount += assignments.redactedCount
      categories.add("credential-assignment")
    }
  }

  const status: RedactionStatus = failureClasses.length > 0 ? "unknown" : "eligible"
  return {
    text,
    status,
    redactedCount,
    unknownCount: failureClasses.length,
    categories: [...categories].sort(),
    failureClasses: [...new Set(failureClasses)].sort(),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isCredentialPath(value: unknown): boolean {
  if (typeof value !== "string") return false
  const normalized = value.replaceAll("\\", "/").toLowerCase()
  if (/(?:^|\/)\.env\.example$/.test(normalized)) return false
  return /(?:^|\/)(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|secrets?(?:\.json)?|auth\.json|id_rsa|id_ed25519)$/.test(
    normalized,
  )
}

function containsCredentialPath(value: unknown): boolean {
  if (isCredentialPath(value)) return true
  if (Array.isArray(value)) return value.some(containsCredentialPath)
  if (isObject(value)) return Object.values(value).some(containsCredentialPath)
  return false
}

export function maskCredentialFileToolOutput(value: unknown): {
  value: unknown
  redactedCount: number
  categories: string[]
} {
  if (!isObject(value) || !isObject(value.state)) {
    return { value, redactedCount: 0, categories: [] }
  }
  const tool = typeof value.tool === "string" ? value.tool.toLowerCase() : ""
  if (["task", "question", "todowrite"].includes(tool) || !containsCredentialPath(value.state.input)) {
    return { value, redactedCount: 0, categories: [] }
  }
  const state = { ...value.state }
  let redactedCount = 0
  if (state.output !== undefined && state.output !== null) {
    state.output = "[REDACTED:credential-file-output]"
    redactedCount++
  }
  if (state.error !== undefined && state.error !== null) {
    state.error = "[REDACTED:credential-file-error]"
    redactedCount++
  }
  return {
    value: { ...value, state },
    redactedCount,
    categories: redactedCount > 0 ? ["credential-file-output"] : [],
  }
}

export function redactStructured(value: unknown): {
  value: unknown
  status: RedactionStatus
  redactedCount: number
  unknownCount: number
  categories: string[]
  failureClasses: string[]
} {
  const categories = new Set<string>()
  const failureClasses = new Set<string>()
  let redactedCount = 0
  let unknownCount = 0

  const walk = (input: unknown, key?: string): unknown => {
    if (key && isSensitiveKey(key)) {
      redactedCount++
      categories.add(keyTokens(key).includes("cookie") ? "cookie-header" : "structured-credential")
      return "[REDACTED:structured-credential]"
    }
    if (input === null || typeof input === "number" || typeof input === "boolean") return input
    if (typeof input === "string") {
      const redacted = redactText(input)
      redactedCount += redacted.redactedCount
      unknownCount += redacted.unknownCount
      redacted.categories.forEach((category) => categories.add(category))
      redacted.failureClasses.forEach((failure) => failureClasses.add(failure))
      return redacted.text
    }
    if (Array.isArray(input)) {
      let output: unknown[] | undefined
      for (let index = 0; index < input.length; index++) {
        const child = walk(input[index])
        if (child !== input[index]) {
          output ??= input.slice()
          output[index] = child
        }
      }
      return output ?? input
    }
    if (isObject(input)) {
      let output: Record<string, unknown> | undefined
      for (const [childKey, child] of Object.entries(input)) {
        const next = walk(child, childKey)
        if (next !== child) {
          output ??= { ...input }
          output[childKey] = next
        }
      }
      return output ?? input
    }
    unknownCount++
    failureClasses.add("unsupported-structured-value")
    return "[REDACTED:unsupported-structured-value]"
  }

  const result = walk(value)
  return {
    value: result,
    status: unknownCount > 0 ? "unknown" : "eligible",
    redactedCount,
    unknownCount,
    categories: [...categories].sort(),
    failureClasses: [...failureClasses].sort(),
  }
}

export function assertNoUnredactedSecrets(contents: Record<string, string>): void {
  for (const [name, content] of Object.entries(contents)) {
    const result = redactText(content)
    if (result.status !== "eligible" || result.redactedCount > 0) {
      throw new Error(
        `Final redaction validation failed for ${name}: status=${result.status}, matches=${result.redactedCount}`,
      )
    }
  }
}

export function assertNoUnredactedSecretsInValue(value: unknown, label = "value"): void {
  const walk = (input: unknown, location: string): void => {
    if (typeof input === "string") {
      const result = redactText(input)
      if (result.status !== "eligible" || result.redactedCount > 0) {
        throw new Error(
          `Structured redaction validation failed at ${location}: status=${result.status}, matches=${result.redactedCount}, categories=${result.categories.join(",")}`,
        )
      }
      return
    }
    if (Array.isArray(input)) {
      input.forEach((item, index) => walk(item, `${location}[${index}]`))
      return
    }
    if (!isObject(input)) return
    for (const [key, child] of Object.entries(input)) {
      if (isSensitiveKey(key)) {
        if (typeof child !== "string" || !/^\[REDACTED:[a-z0-9-]+\]$/i.test(child)) {
          throw new Error(`Structured redaction validation failed for a sensitive value at ${location}.${key}`)
        }
        continue
      }
      const keyResult = redactText(key)
      if (keyResult.status !== "eligible" || keyResult.redactedCount > 0) {
        throw new Error(
          `Structured redaction validation failed for an object key at ${location}: status=${keyResult.status}, matches=${keyResult.redactedCount}, categories=${keyResult.categories.join(",")}`,
        )
      }
      walk(child, `${location}.${key}`)
    }
  }
  walk(value, label)
}
