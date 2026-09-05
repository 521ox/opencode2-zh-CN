import type { TextareaRenderable } from "@opentui/core"
import type { PromptInfo } from "../../prompt/history"

type History = {
  state(input: string): "idle" | "selected" | "edited"
  reset(): void
  move(direction: 1 | -1, input: string): PromptInfo | undefined
}

function moveTextCursor(direction: 1 | -1, input: TextareaRenderable) {
  if (direction === -1 && input.cursorOffset !== 0) {
    if (input.scrollY + input.visualCursor.visualRow === 0) {
      input.cursorOffset = 0
      return true
    }
    input.moveCursorUp()
    return true
  }

  if (direction === 1 && input.cursorOffset !== input.plainText.length) {
    if (input.scrollY + input.visualCursor.visualRow === Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)) {
      input.cursorOffset = input.plainText.length
      return true
    }
    input.moveCursorDown()
    return true
  }

  return false
}

export function navigatePromptHistory(
  direction: 1 | -1,
  input: TextareaRenderable,
  history: History,
  select: (item: PromptInfo) => void,
) {
  const state = history.state(input.plainText)
  if (state === "edited") {
    history.reset()
    moveTextCursor(direction, input)
    return
  }
  if (state === "idle" && moveTextCursor(direction, input)) return

  const item = history.move(direction, input.plainText)
  if (!item) return false
  input.setText(item.text)
  select(item)
  input.cursorOffset = input.plainText.length
}
