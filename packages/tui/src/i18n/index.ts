import { dict as en, type Key } from "./en"
import { dict as zh } from "./zh"

export type Locale = "en" | "zh"
export type Params = Readonly<Record<string, string | number>>
export type Translator = (key: Key, params?: Params) => string

export const DEFAULT_LOCALE: Locale = "zh"

export function resolveLocale(value: string | undefined): Locale {
  if (!value) return DEFAULT_LOCALE
  const normalized = value.trim().toLowerCase().replaceAll("_", "-")
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh"
  return "en"
}

function interpolate(template: string, params: Params | undefined) {
  if (!params) return template
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

export function translate(locale: Locale, key: Key, params?: Params) {
  const template = (locale === "zh" ? zh[key] : undefined) ?? en[key]
  return interpolate(template, params)
}

export type { Key }
