import { buildLocationServiceMap } from "../location-services.js"
import { LocationServiceMap } from "../location-service-map.js"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Effect, Layer } from "effect"
import { Instance } from "../instance/service.js"

const instances = makeGlobalNode({
  service: Instance.Service,
  layer: Layer.effect(
    Instance.Service,
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      return Instance.Service.of({
        provide: (session) => Effect.provide(locations.get(session.location).pipe(Layer.orDie)),
      })
    }),
  ),
  deps: [LocationServiceMap.node],
})

export function build<A, E, T extends LayerNode.Tag | undefined>(
  root: LayerNode.Node<A, E, T>,
  replacements: LayerNode.Replacements = [],
) {
  const bindings: LayerNode.Replacements = [[Instance.node, instances], ...replacements]
  // Only build the location service map if it's actually needed
  if (!LayerNode.hasUnbound(root, LocationServiceMap.node) || hasReplacement(bindings, LocationServiceMap.node))
    return LayerNode.compile(root, bindings)

  const locationMap = buildLocationServiceMap(bindings)
  const locationMapNode = makeGlobalNode({ service: LocationServiceMap.Service, layer: locationMap, deps: [] })
  return LayerNode.compile(root, bindings.concat([[LocationServiceMap.node, locationMapNode]]))
}

function hasReplacement(
  replacements: LayerNode.Replacements,
  node: LayerNode.Node<unknown, unknown, LayerNode.Tag | undefined>,
) {
  return replacements.some(([source]) => source.name === node.name)
}

export * as AppNodeBuilder from "./app-node-builder.js"
