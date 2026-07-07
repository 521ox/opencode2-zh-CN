import { createCliRenderer, type CliRenderer, type CliRendererConfig } from "@opentui/core"
import { DriveManifest } from "../manifest"
import { SimulationActions } from "./actions"
import { SimulationRenderer } from "./renderer"
import { SimulationServer } from "./server"

/**
 * Drive-mode renderer entry point.
 *
 * Creates the renderer (fake when OPENCODE_DRIVE_RENDERER=fake, the normal
 * visible renderer otherwise) and starts the UI control
 * server against it. The server stops when the renderer is destroyed, so the
 * caller only manages the renderer lifecycle.
 */
export async function create(options: CliRendererConfig): Promise<CliRenderer> {
  const renderer =
    process.env.OPENCODE_DRIVE_RENDERER === "fake"
      ? await SimulationRenderer.create(options)
      : await createCliRenderer(options)
  const server = SimulationServer.start(
    SimulationActions.createHarness(renderer),
    DriveManifest.resolve().endpoints.ui,
  )
  process.stderr.write(`opencode drive ui websocket: ${server.url}\n`)
  renderer.once("destroy", () => server.stop())
  return renderer
}

export * as Drive from "./simulation"
