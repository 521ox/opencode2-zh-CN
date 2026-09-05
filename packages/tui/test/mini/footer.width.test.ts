import { describe, expect, test } from "bun:test"
import { footerStatuslinePolicy, footerWidthPolicy } from "../../src/mini/footer.width"

describe("run footer width", () => {
  test("preserves the dialog breakpoint", () => {
    expect(footerWidthPolicy(79).dialog.narrow).toBe(true)
    expect(footerWidthPolicy(80).dialog.narrow).toBe(false)
  })

  test("never shows usage before provider identity", () => {
    for (let width = 1; width <= 200; width++) {
      const result = footerStatuslinePolicy({
        width,
        mainWidth: 12,
        contextWidths: [],
        modelWidth: 8,
        providerWidth: 10,
        usageWidth: 20,
      })
      if (result.showUsage) expect(result.showProvider).toBe(true)
    }
  })
})
