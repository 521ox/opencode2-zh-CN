import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionRetention } from "../../src/context/session-retention"

function setup(input: { current?: string; keep?: string[]; limit?: number } = {}) {
  return createRoot((dispose) => {
    const [current, setCurrent] = createSignal(input.current)
    const [keep, setKeep] = createSignal<readonly string[]>(input.keep ?? [])
    const sessions = new Map<string, { id: string; root: string }>()
    const evictions: string[] = []
    createSessionRetention({
      session: {
        list: () => [...sessions.values()].map((item) => ({ id: item.id })) as never,
        root: (id) => sessions.get(id)?.root ?? id,
        evict(id) {
          evictions.push(id)
        },
      },
      current,
      keep,
      limit: input.limit ?? 3,
    })
    return {
      dispose,
      evictions,
      evictionCount: (id: string) => evictions.filter((item) => item === id).length,
      setCurrent,
      setKeep,
      remember(id: string, root = id) {
        sessions.set(id, { id, root })
        setKeep((value) => [...value])
      },
    }
  })
}

test("retains the current family and the three most recently viewed families", () => {
  const scope = setup({ current: "a" })
  try {
    for (const id of ["a", "b", "c", "d", "e"]) scope.remember(id)
    const initial = {
      a: scope.evictionCount("a"),
      b: scope.evictionCount("b"),
      c: scope.evictionCount("c"),
      d: scope.evictionCount("d"),
      e: scope.evictionCount("e"),
    }
    expect(initial).toEqual({ a: 0, b: 1, c: 1, d: 1, e: 1 })

    scope.setCurrent("b")
    scope.setCurrent("c")
    scope.setCurrent("d")
    expect(scope.evictionCount("b")).toBe(initial.b)
    expect(scope.evictionCount("c")).toBe(initial.c)
    expect(scope.evictionCount("d")).toBe(initial.d)
    expect(scope.evictionCount("e")).toBe(initial.e)
    expect(scope.evictionCount("a")).toBe(initial.a + 1)

    const beforeLeavingRetention = scope.evictionCount("b")
    scope.setCurrent("e")
    expect(scope.evictionCount("e")).toBe(initial.e)
    expect(scope.evictionCount("d")).toBe(initial.d)
    expect(scope.evictionCount("c")).toBe(initial.c)
    expect(scope.evictionCount("b")).toBe(beforeLeavingRetention + 1)
  } finally {
    scope.dispose()
  }
})

test("explicitly kept tab families are outside the recent-family budget", () => {
  const scope = setup({ current: "c", keep: ["a"], limit: 1 })
  try {
    for (const id of ["a", "b", "c"]) scope.remember(id)
    expect(scope.evictionCount("b")).toBe(1)
    expect(scope.evictionCount("a")).toBe(0)
    expect(scope.evictionCount("c")).toBe(0)

    const kept = scope.evictionCount("a")
    scope.setKeep([])
    expect(scope.evictionCount("a")).toBe(kept + 1)

    const current = scope.evictionCount("b")
    scope.setCurrent("b")
    expect(scope.evictionCount("b")).toBe(current)
    expect(scope.evictionCount("c")).toBe(1)
  } finally {
    scope.dispose()
  }
})

test("child navigation and late ancestry retain the root family", () => {
  const scope = setup({ current: "child", limit: 1 })
  try {
    scope.remember("root")
    const beforeAncestry = scope.evictionCount("root")
    expect(beforeAncestry).toBe(1)
    scope.remember("child", "root")
    scope.remember("other")
    expect(scope.evictionCount("other")).toBe(1)
    expect(scope.evictionCount("root")).toBe(beforeAncestry)

    scope.setCurrent("other")
    expect(scope.evictionCount("other")).toBe(1)
    expect(scope.evictionCount("root")).toBe(beforeAncestry + 1)
  } finally {
    scope.dispose()
  }
})
