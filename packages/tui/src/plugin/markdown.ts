import { createMarkdownCodeBlockRenderer, type MarkdownCodeBlockRenderer } from "@opentui/core"
import { isShallowEqual } from "remeda"
import { createMemo } from "solid-js"

export function createMarkdownRenderer(
  sources: () => ReadonlyArray<Readonly<Record<string, MarkdownCodeBlockRenderer>>>,
) {
  // Keep mounted fences when toggles do not change the effective language handlers.
  const renderers = createMemo(
    () => Object.fromEntries(sources().flatMap((source) => Object.entries(source))),
    undefined,
    { equals: isShallowEqual },
  )
  return createMemo(() =>
    Object.keys(renderers()).length === 0 ? undefined : createMarkdownCodeBlockRenderer(renderers()),
  )
}
