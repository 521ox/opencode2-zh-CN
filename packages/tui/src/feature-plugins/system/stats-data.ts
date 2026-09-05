import type { SessionStatsInfo } from "@opencode-ai/client"
import { TokenUsage } from "@opencode-ai/schema/token-usage"
import type { Key, Locale, Translator } from "../../i18n"

type Metric = {
  label: Key
  unit?: Key
  value: number
}

export function statsMetrics(stats: SessionStatsInfo, t: Translator) {
  const metrics: Metric[] = [
    {
      label: "feature.stats.metric.tokens",
      value: TokenUsage.total(stats.tokens),
    },
    { label: "feature.stats.metric.bestStreak", unit: "feature.stats.unit.days", value: stats.streak },
    { label: "feature.stats.metric.activeDays", value: stats.activeDays },
    { label: "feature.stats.metric.sessions", value: stats.sessions },
  ]
  return metrics.map((metric) => ({ ...metric, label: t(metric.label) }))
}

export function statsNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)
}
