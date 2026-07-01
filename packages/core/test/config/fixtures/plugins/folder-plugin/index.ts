import { define } from "@opencode-ai/plugin/v2/promise"

export default define({
  id: "folder-plugin",
  setup: async (ctx) => {
    await ctx.agent.transform((agents) => {
      agents.update("folder", (agent) => {
        agent.description = "Loaded from plugin folder"
        agent.mode = "subagent"
      })
    })
  },
})
