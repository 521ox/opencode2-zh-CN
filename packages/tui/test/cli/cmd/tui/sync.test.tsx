/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mount } from "./sync-fixture"

test("legacy sync is an inert compatibility context", async () => {
  const { app, session, sync } = await mount()

  try {
    expect(sync.status).toBe("complete")
    expect(sync.ready).toBe(true)
    expect(sync.data.session).toEqual([])
    expect(sync.data.message).toEqual({})
    expect(sync.data.provider).toEqual([])
    expect(sync.session.get("ses_test")).toBeUndefined()

    await sync.bootstrap()
    await sync.session.refresh()
    await sync.session.sync("ses_test")

    expect(session).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
