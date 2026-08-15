import { dict as en } from "../en/misc"

export const dict = {
  "misc.plugin.failed.title": "插件加载失败：{{target}}",
  "misc.plugin.failed.message": "运行 /plugins 查看详细信息。",
  "misc.plugin.failed.action": "打开插件",
} satisfies Partial<Record<keyof typeof en, string>>
