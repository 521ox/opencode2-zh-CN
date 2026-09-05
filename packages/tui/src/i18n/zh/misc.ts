import { dict as en } from "../en/misc"

export const dict = {
  "misc.plugin.failed.title": "插件加载失败：{{target}}",
  "misc.plugin.failed.multiple": "{{count}} 个插件加载失败",
  "misc.plugin.failed.message": "运行 /plugins 查看详细信息。",
  "misc.plugin.failed.action": "打开插件",
  "misc.plugin.cleanupFailed": "{{id}}：清理失败：{{error}}",
  "misc.plugin.crashed": "{{id}} 在 {{where}} 中崩溃：{{error}}",
  "misc.plugin.title": "插件",
} satisfies Partial<Record<keyof typeof en, string>>
