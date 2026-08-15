import { expect, test } from "bun:test"
import { translate } from "../../../src/i18n"
import { permissionSemanticLabel } from "../../../src/routes/session/permission"

test("uses the permission action when a surface has no display title", () => {
  expect(permissionSemanticLabel("shell")).toBe("Permission required: shell")
  expect(permissionSemanticLabel("edit", "Edit fixture.txt")).toBe("Permission required: Edit fixture.txt")
  expect(permissionSemanticLabel("shell", undefined, (key, params) => translate("zh", key, params))).toBe("需要权限：shell")
})
