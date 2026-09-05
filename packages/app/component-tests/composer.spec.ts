import { expect, story } from "../../storybook/playwright/story"

story("raises the docked composer only in dark mode", async ({ mount }) => {
  const component = await mount("opencode-composer-flow--empty-draft")
  const composer = component.locator('[data-component="composer"]')

  await component.evaluate((root) => root.setAttribute("data-color-scheme", "light"))
  await expect(composer).toHaveCSS("background-color", "rgb(255, 255, 255)")

  await component.evaluate((root) => root.setAttribute("data-color-scheme", "dark"))
  await expect(composer).toHaveCSS("background-color", "rgb(36, 36, 36)")
})

story("centers add menu shortcuts in a consistent column", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--empty-draft")
  await component.locator('[data-action="composer-attach"]').click()

  const shortcuts = page.locator('[role="menu"] [data-slot="menu-v2-item-shortcut"]')
  await expect(shortcuts).toHaveCount(4)
  const boxes = await shortcuts.evaluateAll((items) =>
    items.map((item) => {
      const box = item.getBoundingClientRect()
      return { width: box.width, center: box.left + box.width / 2 }
    }),
  )

  expect(new Set(boxes.map((box) => box.width)).size).toBe(1)
  expect(new Set(boxes.map((box) => box.center)).size).toBe(1)
})

// Moved from packages/app/e2e/regression/prompt-thinking-level.spec.ts
story("shows the thinking level control while relevant", async ({ mount, page }) => {
  const component = await mount("opencode-composer-flow--model-and-variant")
  const composer = component.locator('[data-component="composer"]')
  const input = composer.locator('[data-component="composer-editor"]')
  const control = composer.getByRole("button", { name: "Choose model variant" })

  await page.mouse.move(0, 0)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(control).toBeVisible()

  await control.click()
  const high = page.getByRole("menuitemradio", { name: "high" })
  await expect(high).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(control).toBeVisible()
  await expect(high).toBeVisible()
  await high.click()

  await input.focus()
  await expect(control).toBeVisible()
  await input.blur()
  await expect(control).toBeVisible()
})
