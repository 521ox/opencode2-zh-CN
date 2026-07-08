import type { SessionMessage, SessionMessageAssistant } from "@opencode-ai/sdk/v2"
import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useData } from "../../context/data"

export type PartRef = {
  messageID: string
  partID: string
}

export type SessionRow =
  | { type: "message"; messageID: string }
  | { type: "part"; ref: PartRef }
  | {
      type: "group"
      kind: "exploration"
      refs: PartRef[]
      pending: PartRef[]
      completed: boolean
    }
  | { type: "assistant-footer"; messageID: string }

export function createSessionRows(sessionID: Accessor<string>) {
  const data = useData()
  const [rows, setRows] = createStore<SessionRow[]>([])
  const revertBoundary = () => data.session.get(sessionID())?.revert?.messageID

  function pendingIDs() {
    const inputs = data.session.input.list(sessionID())
    const pending = new Set(inputs)
    for (const message of data.session.message.list(sessionID())) {
      if (message.type === "compaction" && (message.status === "queued" || message.status === "running"))
        pending.add(message.id)
    }
    return pending
  }

  function reduce() {
    const messages = data.session.message.list(sessionID())
    const boundary = revertBoundary()
    const visible = boundary ? messages.filter((message) => message.id < boundary) : messages
    const pending = pendingIDs()
    const rows = reduceSessionRows(visible.filter((message) => !pending.has(message.id)))
    partitionPending(rows, pendingPermissions())
    return rows
  }

  function pendingPermissions() {
    return new Set(
      (data.session.permission.list(sessionID()) ?? []).flatMap((request) =>
        request.source?.type === "tool" ? [request.source.callID] : [],
      ),
    )
  }

  createEffect(() => {
    const pending = pendingPermissions()
    setRows(
      produce((draft) => {
        partitionPending(draft, pending)
      }),
    )
  })

  createEffect(
    on(sessionID, () => {
      setRows(reduce())
    }),
  )

  createEffect(
    on(revertBoundary, () => {
      setRows(reduce())
    }),
  )

  // Pending inputs and compaction leaving the pending set change history membership.
  createEffect(
    on(
      () => {
        const messages = data.session.message.list(sessionID())
        const pending = data.session.input.list(sessionID()).join("\0")
        const compaction = messages
          .filter((message) => message.type === "compaction")
          .map((message) => `${message.id}:${message.status}`)
          .join("\0")
        return `${pending}\u0001${compaction}`
      },
      () => setRows(reduce()),
    ),
  )

  const appendMessage = (messageID: string) =>
    setRows(
      produce((draft) => {
        if (draft.some((row) => row.type === "message" && row.messageID === messageID)) return
        if (pendingIDs().has(messageID)) return
        completePrevious(draft)
        draft.push({ type: "message", messageID })
      }),
    )

  const appendPart = (ref: PartRef, name?: string) =>
    setRows(
      produce((draft) => {
        if (hasPart(draft, ref)) return
        if (name && exploration(name)) {
          const previous = draft.at(-1)
          if (previous?.type === "group" && previous.kind === "exploration") {
            previous.refs.push(ref)
            return
          }
          completePrevious(draft)
          draft.push({
            type: "group",
            kind: "exploration",
            refs: [ref],
            pending: [],
            completed: false,
          })
          return
        }
        completePrevious(draft)
        draft.push({ type: "part", ref })
      }),
    )

  const appendFooter = (messageID: string) =>
    setRows(
      produce((draft) => {
        if (draft.some((row) => row.type === "assistant-footer" && row.messageID === messageID)) return
        completePrevious(draft)
        draft.push({ type: "assistant-footer", messageID })
      }),
    )

  const removeFooter = (messageID: string) =>
    setRows(
      produce((draft) => {
        const index = draft.findIndex((row) => row.type === "assistant-footer" && row.messageID === messageID)
        if (index !== -1) draft.splice(index, 1)
      }),
    )

  const message = (event: { id: string; data: { sessionID: string } }) => {
    if (event.data.sessionID === sessionID()) appendMessage(event.id.replace(/^evt_/, "msg_"))
  }
  const subscriptions = [
    data.on("session.prompt.promoted", (event) => {
      if (event.data.sessionID === sessionID()) appendMessage(event.data.inputID)
    }),
    data.on("session.instructions.updated", message),
    data.on("session.synthetic", (event) => {
      if (event.data.sessionID === sessionID() && event.data.description?.trim())
        appendMessage(event.id.replace(/^evt_/, "msg_"))
    }),
    data.on("session.shell.started", message),
    data.on("session.agent.selected", message),
    data.on("session.model.selected", message),

    data.on("session.text.delta", (event) => {
      if (event.data.sessionID === sessionID())
        appendPart({ messageID: event.data.assistantMessageID, partID: `text:${event.data.ordinal}` })
    }),
    data.on("session.text.ended", (event) => {
      if (event.data.sessionID === sessionID() && event.data.text.trim())
        appendPart({ messageID: event.data.assistantMessageID, partID: `text:${event.data.ordinal}` })
    }),
    data.on("session.reasoning.delta", (event) => {
      if (event.data.sessionID === sessionID())
        appendPart({ messageID: event.data.assistantMessageID, partID: `reasoning:${event.data.ordinal}` })
    }),
    data.on("session.reasoning.ended", (event) => {
      if (event.data.sessionID === sessionID() && event.data.text.trim())
        appendPart({ messageID: event.data.assistantMessageID, partID: `reasoning:${event.data.ordinal}` })
    }),
    data.on("session.tool.input.started", (event) => {
      if (event.data.sessionID === sessionID())
        appendPart({ messageID: event.data.assistantMessageID, partID: event.data.callID }, event.data.name)
    }),
    data.on("session.retry.scheduled", (event) => {
      if (event.data.sessionID === sessionID()) appendFooter(event.data.assistantMessageID)
    }),
    data.on("session.step.started", (event) => {
      if (event.data.sessionID === sessionID()) removeFooter(event.data.assistantMessageID)
    }),
    data.on("session.step.ended", (event) => {
      if (event.data.sessionID !== sessionID() || ["tool-calls", "unknown"].includes(event.data.finish)) return
      appendFooter(event.data.assistantMessageID)
    }),
    data.on("session.step.failed", (event) => {
      if (event.data.sessionID === sessionID()) appendFooter(event.data.assistantMessageID)
    }),
  ]
  onCleanup(() => subscriptions.forEach((unsubscribe) => unsubscribe()))

  return rows
}

export function reduceSessionRows(messages: SessionMessage[]) {
  return messages.reduce<SessionRow[]>((rows, message) => {
    if (message.type !== "assistant") {
      if (message.type === "synthetic" && !message.description?.trim()) return rows
      completePrevious(rows)
      rows.push({ type: "message", messageID: message.id })
      return rows
    }
    const ordinals = { text: 0, reasoning: 0 }
    message.content.forEach((part) => {
      const partID = part.type === "tool" ? part.id : `${part.type}:${ordinals[part.type]++}`
      if ((part.type === "text" || part.type === "reasoning") && !part.text.trim()) return
      append(rows, { messageID: message.id, partID }, part)
    })
    if ((message.finish && !["tool-calls", "unknown"].includes(message.finish)) || message.error || message.retry) {
      completePrevious(rows)
      rows.push({ type: "assistant-footer", messageID: message.id })
    }
    return rows
  }, [])
}

export function resolvePart(message: SessionMessageAssistant, partID: string) {
  const tool = message.content.find((part) => part.type === "tool" && part.id === partID)
  if (tool) return tool
  const match = /^(text|reasoning):(\d+)$/.exec(partID)
  if (!match) return
  const ordinal = Number(match[2])
  return message.content.filter((part) => part.type === match[1])[ordinal]
}

function append(rows: SessionRow[], ref: PartRef, part: SessionMessageAssistant["content"][number]) {
  if (part.type === "tool") {
    if (exploration(part.name)) {
      const previous = rows.at(-1)
      if (previous?.type === "group" && previous.kind === "exploration") {
        previous.refs.push(ref)
        return
      }
      completePrevious(rows)
      rows.push({ type: "group", kind: "exploration", refs: [ref], pending: [], completed: false })
      return
    }
  }
  completePrevious(rows)
  rows.push({ type: "part", ref })
}

function completePrevious(rows: SessionRow[], index = rows.length) {
  const previous = rows[index - 1]
  if (previous?.type === "group") previous.completed = true
}

function partitionPending(rows: SessionRow[], pending: Set<string>) {
  rows.forEach((row) => {
    if (row.type !== "group") return
    const refs = [...row.refs, ...row.pending]
    row.refs = refs.filter((ref) => !pending.has(ref.partID))
    row.pending = refs.filter((ref) => pending.has(ref.partID))
  })
}

function exploration(name: string) {
  return ["read", "glob", "grep"].includes(name.toLowerCase())
}

function hasPart(rows: SessionRow[], ref: PartRef) {
  return rows.some((row) => {
    if (row.type === "part") return row.ref.messageID === ref.messageID && row.ref.partID === ref.partID
    if (row.type !== "group") return false
    return [...row.refs, ...row.pending].some((item) => item.messageID === ref.messageID && item.partID === ref.partID)
  })
}
