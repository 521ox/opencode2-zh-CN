import type { Rpc } from "@opencode-ai/schema/rpc"
import type { Effect, Schema, Scope, Stream } from "effect"
import type { Registration } from "./registration.js"

type RpcArguments<Input> = unknown extends Input
  ? [input: Input]
  : undefined extends Input
    ? [input?: Input]
    : [input: Input]
type DecodeError<S> = S extends Schema.Top ? Schema.SchemaError : never

export type RpcClient<D extends Rpc.Definition, E = never, EventError = E> = {
  readonly [Name in keyof D["methods"]]: (
    ...args: RpcArguments<Rpc.Input<D["methods"][Name]["input"]>>
  ) => Effect.Effect<
    Rpc.Output<D["methods"][Name]["output"]>,
    Rpc.MethodError<D["methods"][Name]> | DecodeError<D["methods"][Name]["output"]> | E
  >
} & {
  readonly events: {
    readonly subscribe: <Name extends keyof D["events"] & string>(
      name: Name,
    ) => Stream.Stream<Rpc.EventPayload<D, Name>, DecodeError<D["events"][Name]["schema"]> | EventError>
  }
}

export interface RpcApi<E = never, EventError = E> {
  <D extends Rpc.Definition>(definition: D): RpcClient<D, E, EventError>
}

export interface RpcCallContext<M extends Rpc.Method> {
  readonly error: Rpc.ErrorFactory<M>
}

export type RpcHandlers<D extends Rpc.Definition> = {
  readonly [Name in keyof D["methods"]]: (
    input: Rpc.Output<D["methods"][Name]["input"]>,
    context: RpcCallContext<D["methods"][Name]>,
  ) => Effect.Effect<Rpc.HandlerOutput<D["methods"][Name]["output"]>, Rpc.HandlerError<D["methods"][Name]>>
}

export interface RpcRegistration<D extends Rpc.Definition> extends Registration {
  readonly events: {
    readonly emit: (...args: Rpc.EventInput<D>) => Effect.Effect<void, unknown>
  }
}

export interface RpcDomain extends RpcApi<Rpc.SystemError, unknown> {
  readonly register: <const D extends Rpc.Definition>(
    definition: D,
    handlers: RpcHandlers<NoInfer<D>>,
  ) => Effect.Effect<RpcRegistration<D>, unknown, Scope.Scope>
}
