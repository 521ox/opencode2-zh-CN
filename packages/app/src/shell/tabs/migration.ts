import type { ServerConnection } from "@/runtime/server/registry"
import type { Tab } from "./tabs"
import { Schema, SchemaGetter } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { TabStorage } from "./schema"

export function migrateTabs(value: unknown): Tab[] {
  if (!Array.isArray(value)) return []
  return value.flatMap<Tab>((tab) => {
    if (!tab || typeof tab !== "object") return []
    if (!("server" in tab) || typeof tab.server !== "string") return []
    const server = tab.server as ServerConnection.Key
    if (tab.type === "session" && typeof tab.sessionId === "string") {
      const routeSessionId =
        typeof tab.routeSessionId === "string" && tab.routeSessionId !== tab.sessionId
          ? tab.routeSessionId
          : undefined
      return [
        {
          type: tab.type,
          server,
          sessionId: tab.sessionId,
          ...(routeSessionId
            ? {
                routeSessionId,
                ...(typeof tab.routeParentId === "string" && tab.routeParentId
                  ? { routeParentId: tab.routeParentId }
                  : {}),
              }
            : {}),
        },
      ]
    }
    if (
      tab.type === "draft" &&
      typeof tab.draftID === "string" &&
      typeof tab.directory === "string" &&
      (tab.worktree === undefined || typeof tab.worktree === "string") &&
      (tab.branch === undefined || typeof tab.branch === "string")
    ) {
      return [
        {
          type: tab.type,
          server,
          draftID: tab.draftID,
          directory: tab.directory,
          worktree: tab.worktree,
          branch: tab.branch,
        },
      ]
    }
    return []
  })
}

export const TabsSchema = Persistence.migrate(
  TabStorage.Tabs,
  Schema.Unknown.pipe(
    Schema.decode({
      decode: SchemaGetter.transform(migrateTabs),
      encode: SchemaGetter.transform((value) => value),
    }),
  ),
)
