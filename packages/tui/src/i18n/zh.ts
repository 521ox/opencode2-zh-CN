import { dict as app } from "./zh/app"
import { dict as common } from "./zh/common"
import { dict as dialogs } from "./zh/dialogs"
import { dict as feature } from "./zh/feature"
import { dict as mini } from "./zh/mini"
import { dict as misc } from "./zh/misc"
import { dict as session } from "./zh/session"
import { dict as ui } from "./zh/ui"
import type { Key } from "./en"

export const dict = {
  ...common,
  ...app,
  ...dialogs,
  ...feature,
  ...mini,
  ...misc,
  ...session,
  ...ui,
} satisfies Partial<Record<Key, string>>
