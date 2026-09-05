function normalize(value: unknown, rootOrder?: string[], isRoot = true): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers")
    return value
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64")
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : normalize(item, undefined, false)))
  if (typeof value === "object") {
    const output: Record<string, unknown> = {}
    const sourceKeys = Object.keys(value as Record<string, unknown>)
    const keys = isRoot && rootOrder
      ? [...rootOrder.filter((key) => sourceKeys.includes(key)), ...sourceKeys.filter((key) => !rootOrder.includes(key)).sort()]
      : sourceKeys.sort()
    for (const key of keys) {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) output[key] = normalize(item, undefined, false)
    }
    return output
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`)
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function canonicalPrettyJSON(value: unknown, rootOrder?: string[]): string {
  return `${JSON.stringify(normalize(value, rootOrder), null, 2)}\n`
}
