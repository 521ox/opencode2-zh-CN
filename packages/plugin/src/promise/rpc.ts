import type { EventSubscribeOutput } from "@opencode-ai/client"
import type { Rpc } from "@opencode-ai/schema/rpc"
import type { Registration } from "./registration.js"

export interface RpcCallOptions {
  readonly signal?: AbortSignal
}

type RpcArguments<Input, Options> = unknown extends Input
  ? [input: Input, options?: Options]
  : undefined extends Input
    ? [input?: Input, options?: Options]
    : [input: Input, options?: Options]

type RpcEvent = Extract<EventSubscribeOutput, { readonly type: `rpc.${string}` }>
type RpcEventPayloadFor<
  D extends Rpc.PortableDefinition,
  Name extends keyof D["events"] & string,
> = Omit<RpcEvent, "type" | "data"> & {
  readonly type: `rpc.${D["id"]}.${Name}`
  readonly data: Rpc.EventData<D["events"][Name]["schema"]>
}

export type RpcEventPayload<
  D extends Rpc.PortableDefinition,
  Name extends keyof D["events"] & string = keyof D["events"] & string,
> = { readonly [K in Name]: RpcEventPayloadFor<D, K> }[Name]

export type RpcClient<D extends Rpc.PortableDefinition, Options = RpcCallOptions> = {
  readonly [Name in keyof D["methods"]]: (
    ...args: RpcArguments<Rpc.Input<D["methods"][Name]["input"]>, Options>
  ) => Promise<Rpc.Output<D["methods"][Name]["output"]>>
} & {
  readonly events: {
    readonly subscribe: <Name extends keyof D["events"] & string>(
      name: Name,
      options?: Pick<RpcCallOptions, "signal">,
    ) => AsyncIterable<RpcEventPayload<D, Name>>
    readonly on: <Name extends keyof D["events"] & string>(
      name: Name,
      handler: (event: RpcEventPayload<D, Name>) => Promise<void> | void,
      options?: Pick<RpcCallOptions, "signal">,
    ) => () => void
  }
}

export interface RpcCallContext<M extends Rpc.Method> {
  readonly signal: AbortSignal
  readonly error: Rpc.ErrorFactory<M>
}

export type RpcHandlers<D extends Rpc.PortableDefinition> = {
  readonly [Name in keyof D["methods"]]: (
    input: Rpc.Output<D["methods"][Name]["input"]>,
    context: RpcCallContext<D["methods"][Name]>,
  ) => Promise<Rpc.HandlerOutput<D["methods"][Name]["output"]> | Rpc.HandlerError<D["methods"][Name]>>
}

export interface RpcRegistration<D extends Rpc.PortableDefinition> extends Registration {
  readonly events: {
    readonly emit: (...args: Rpc.EventInput<D>) => Promise<void>
  }
}

export interface RpcDomain {
  <D extends Rpc.PortableDefinition>(
    definition: D,
  ): RpcClient<D, Pick<RpcCallOptions, "signal">>
  readonly register: <const D extends Rpc.PortableDefinition>(
    definition: D,
    handlers: RpcHandlers<NoInfer<D>>,
  ) => Promise<RpcRegistration<D>>
}
