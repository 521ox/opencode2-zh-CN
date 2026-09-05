import { SessionMessage } from "./message.js"

export const remoteFunctionCallIDs = (remote: readonly unknown[] | undefined) => {
  const ids = new Set<string>()
  for (const item of remote ?? []) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    if (record.type !== "function_call") continue
    if (typeof record.call_id === "string" && record.call_id.length > 0) ids.add(record.call_id)
    if (typeof record.id === "string" && record.id.length > 0) ids.add(record.id)
  }
  return ids
}

export const matchesRemoteFunctionCall = (toolID: string, ids: ReadonlySet<string>) => {
  if (ids.has(toolID)) return true
  if (toolID.startsWith("call_") && ids.has(`fc_${toolID.slice("call_".length)}`)) return true
  if (toolID.startsWith("fc_") && ids.has(`call_${toolID.slice("fc_".length)}`)) return true
  return false
}

export const slimAssistantForRemoteFunctionCalls = (
  assistant: SessionMessage.Assistant,
  ids: ReadonlySet<string>,
): SessionMessage.Assistant | undefined => {
  if (ids.size === 0) return undefined
  const content = assistant.content.filter(
    (item): item is SessionMessage.AssistantTool =>
      item.type === "tool" && item.executed !== true && matchesRemoteFunctionCall(item.id, ids),
  )
  if (content.length === 0) return undefined
  return SessionMessage.Assistant.make({ ...assistant, content })
}

export const attachRemoteCompactionToolResults = (
  messages: readonly SessionMessage.Info[],
  previousAssistant: SessionMessage.Assistant | undefined,
): SessionMessage.Info[] => {
  const first = messages[0]
  if (!previousAssistant || first?.type !== "compaction" || first.status !== "completed") return [...messages]
  const slim = slimAssistantForRemoteFunctionCalls(previousAssistant, remoteFunctionCallIDs(first.remote))
  if (!slim) return [...messages]
  return [first, slim, ...messages.slice(1)]
}
