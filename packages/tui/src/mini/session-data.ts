import type { Translator } from "../i18n"
import type { FooterView, MiniFormRequest, MiniPermissionRequest } from "./types"

export function pickBlockerView(input: { permission?: MiniPermissionRequest; form?: MiniFormRequest }): FooterView {
  if (input.permission) return { type: "permission", request: input.permission }
  if (input.form) return { type: "form", request: input.form }
  return { type: "prompt" }
}

export function blockerStatus(view: FooterView, t: Translator) {
  if (view.type === "permission") return t("mini.transport.status.awaitingPermission")
  if (view.type === "form") return t("mini.transport.status.awaitingForm")
  return ""
}
