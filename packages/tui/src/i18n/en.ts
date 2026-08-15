import { dict as app } from "./en/app"
import { dict as common } from "./en/common"
import { dict as dialogs } from "./en/dialogs"
import { dict as feature } from "./en/feature"
import { dict as mini } from "./en/mini"
import { dict as misc } from "./en/misc"
import { dict as session } from "./en/session"
import { dict as ui } from "./en/ui"

export const dict = {
  ...common,
  ...app,
  ...dialogs,
  ...feature,
  ...mini,
  ...misc,
  ...session,
  ...ui,
} as const

export type Key = keyof typeof dict
