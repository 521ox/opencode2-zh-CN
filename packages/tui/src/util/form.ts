import type { FormField, FormValue } from "@opencode-ai/client"
import { translate, type Translator } from "../i18n"

const englishTranslator: Translator = (key, params) => translate("en", key, params)

export type FormAnswerField = Exclude<FormField, { type: "external" }>

export type FormRow = {
  value: string | boolean
  label: string
  description?: string
}

export function isFormAnswerField(field: FormField): field is FormAnswerField {
  return field.type !== "external"
}

export function formLabel(field: FormField) {
  return field.title ?? (field.type === "external" ? field.url : field.key)
}

export function formInitialValues(fields: ReadonlyArray<FormField>) {
  return {
    answers: Object.fromEntries(
      fields.flatMap((field) =>
        isFormAnswerField(field) && field.default !== undefined ? [[field.key, field.default]] : [],
      ),
    ) as Record<string, FormValue | undefined>,
    custom: Object.fromEntries(
      fields.flatMap((field) => {
        if (field.type !== "string" || !field.options || !field.custom || typeof field.default !== "string") return []
        if (field.options.some((option) => option.value === field.default)) return []
        return [[field.key, field.default]]
      }),
    ) as Record<string, string>,
  }
}

export function formTextual(field: FormField | undefined) {
  if (!field) return false
  return field.type === "number" || field.type === "integer" || (field.type === "string" && !field.options)
}

export function formCustom(field: FormField | undefined) {
  if (!field) return false
  if (field.type === "string" && field.options) return field.custom === true
  return field.type === "multiselect" && field.custom === true
}

export function formRows(field: FormField | undefined, t: Translator = englishTranslator): FormRow[] {
  if (!field) return []
  if (field.type === "boolean")
    return [
      { value: true, label: t("common.form.option.yes") },
      { value: false, label: t("common.form.option.no") },
    ]
  const options = field.type === "multiselect" ? field.options : field.type === "string" ? field.options : undefined
  if (!options) return []
  return options.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  }))
}

export function formSelected(field: FormField | undefined, value: FormValue | undefined) {
  if (!field || value === undefined || Array.isArray(value)) return 0
  const rows = formRows(field)
  const index = rows.findIndex((row) => row.value === value)
  if (index !== -1) return index
  if (typeof value === "string" && formCustom(field)) return rows.length
  return 0
}

export function formValidateValue(
  field: FormAnswerField,
  value: FormValue | undefined,
  t: Translator = englishTranslator,
): string | undefined {
  if (value === undefined) return field.required ? t("common.form.validation.answerRequired") : undefined
  if (field.required && (value === "" || (Array.isArray(value) && value.length === 0)))
    return field.type === "multiselect"
      ? t("common.form.validation.selectAtLeastOne")
      : t("common.form.validation.answerRequired")
  if (field.type === "string") {
    if (typeof value !== "string") return t("common.form.validation.expectedText")
    if (field.minLength !== undefined && value.length < field.minLength)
      return t("common.form.validation.minCharacters", { count: field.minLength })
    if (field.maxLength !== undefined && value.length > field.maxLength)
      return t("common.form.validation.maxCharacters", { count: field.maxLength })
    if (field.pattern !== undefined) {
      try {
        if (!new RegExp(field.pattern).test(value))
          return t("common.form.validation.matchPattern", { pattern: field.pattern })
      } catch {
        return t("common.form.validation.invalidPattern", { pattern: field.pattern })
      }
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      return t("common.form.validation.expectedEmail")
    if (field.format === "uri" && !validURL(value)) return t("common.form.validation.expectedUrl")
    if (field.format === "date" && !validDate(value)) return t("common.form.validation.expectedDate")
    if (field.format === "date-time" && Number.isNaN(new Date(value).getTime()))
      return t("common.form.validation.expectedDateTime")
    if (field.options && !field.custom && !field.options.some((option) => option.value === value))
      return t("common.form.validation.selectAvailable")
    return
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return t("common.form.validation.expectedNumber")
    if (field.type === "integer" && !Number.isInteger(value)) return t("common.form.validation.expectedInteger")
    if (typeof field.minimum === "number" && value < field.minimum)
      return t("common.form.validation.minValue", { value: field.minimum })
    if (typeof field.maximum === "number" && value > field.maximum)
      return t("common.form.validation.maxValue", { value: field.maximum })
    return
  }
  if (field.type === "boolean")
    return typeof value === "boolean" ? undefined : t("common.form.validation.expectedBoolean")
  if (!Array.isArray(value)) return t("common.form.validation.expectedSelections")
  if (field.minItems !== undefined && value.length < field.minItems)
    return t("common.form.validation.selectAtLeast", { count: field.minItems })
  if (field.maxItems !== undefined && value.length > field.maxItems)
    return t("common.form.validation.selectAtMost", { count: field.maxItems })
  if (!field.custom && value.some((item) => !field.options.some((option) => option.value === item)))
    return t("common.form.validation.selectOnlyAvailable")
}

export function formDisplayValue(
  field: FormAnswerField,
  value: FormValue | undefined,
  emptyMultiselect: string,
  t: Translator = englishTranslator,
) {
  if (value === undefined) return ""
  const label = (item: string | number | boolean) =>
    formRows(field, t).find((row) => row.value === item)?.label ?? String(item)
  if (Array.isArray(value)) return value.length === 0 ? emptyMultiselect : value.map(label).join(", ")
  return label(value)
}

export function formToggleMultiselect(value: FormValue | undefined, item: string) {
  const values = Array.isArray(value) ? value : []
  const index = values.indexOf(item)
  return index === -1 ? [...values, item] : values.toSpliced(index, 1)
}

export function formSetMultiselectCustom(value: FormValue | undefined, previous: string | undefined, next: string) {
  const values = Array.isArray(value) ? value : []
  const index = previous ? values.indexOf(previous) : -1
  const current = index === -1 ? [...values] : values.toSpliced(index, 1)
  return next && !current.includes(next) ? [...current, next] : current
}

function validURL(value: string) {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
