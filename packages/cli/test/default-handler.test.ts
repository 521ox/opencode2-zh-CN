import { expect, test } from "bun:test"
import { Option } from "effect"
import { interactiveServerArgs } from "../src/commands/handlers/default"

test("interactive TUI defaults to a private standalone server", () => {
  expect(interactiveServerArgs({ server: Option.none(), standalone: false })).toEqual({
    server: undefined,
    standalone: true,
  })
})

test("interactive TUI preserves an explicit server connection", () => {
  expect(interactiveServerArgs({ server: Option.some("http://127.0.0.1:12345"), standalone: false })).toEqual({
    server: "http://127.0.0.1:12345",
    standalone: false,
  })
})

test("interactive TUI preserves an explicitly supplied empty server for downstream validation", () => {
  expect(interactiveServerArgs({ server: Option.some(""), standalone: false })).toEqual({
    server: "",
    standalone: false,
  })
})

test("interactive TUI preserves an explicit conflicting standalone request for validation", () => {
  expect(interactiveServerArgs({ server: Option.some("http://127.0.0.1:12345"), standalone: true })).toEqual({
    server: "http://127.0.0.1:12345",
    standalone: true,
  })
})
