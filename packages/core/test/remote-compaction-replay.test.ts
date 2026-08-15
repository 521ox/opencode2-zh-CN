import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { Model } from "@opencode-ai/core/model"
import { Provider } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import {
  attachRemoteCompactionToolResults,
  remoteFunctionCallIDs,
} from "../src/session/remote-compaction-replay.js"

const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)

describe("remote compaction replay", () => {
  test("collects function call ids from remote output", () => {
    expect(
      [...remoteFunctionCallIDs([
        { type: "compaction", encrypted_content: "cipher" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "read" },
      ])],
    ).toEqual(["call_1", "fc_1"])
  })

  test("attaches matching previous tool results after a remote checkpoint", () => {
    const remote = [
      { type: "compaction", encrypted_content: "cipher" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "read" },
    ]
    const attached = attachRemoteCompactionToolResults(
      [
        SessionMessage.Compaction.make({
          id: id("compaction"),
          type: "compaction",
          status: "completed",
          reason: "auto",
          summary: "",
          recent: "",
          remote,
          time: { created },
        }),
        SessionMessage.User.make({
          id: id("next-user"),
          type: "user",
          text: "continue",
          time: { created },
        }),
      ],
      SessionMessage.Assistant.make({
        id: id("previous"),
        type: "assistant",
        agent: Agent.defaultID,
        model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
        content: [
          SessionMessage.AssistantText.make({ type: "text", text: "Working" }),
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: "call_1",
            name: "read",
            state: SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: { path: "README.md" },
              content: [{ type: "text", text: "Hello" }],
            }),
            time: { created, completed: created },
          }),
        ],
        time: { created, completed: created },
      }),
    )

    expect(attached.map((message) => message.type)).toEqual(["compaction", "assistant", "user"])
    expect(attached[1]).toMatchObject({
      type: "assistant",
      content: [{ type: "tool", id: "call_1", name: "read" }],
    })
  })
})
