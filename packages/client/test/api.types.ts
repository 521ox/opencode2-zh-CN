import { Effect } from "effect"
import { OpenCode as EffectOpenCode, type AppApi as EffectApi } from "../src/effect"

type EffectClient = Effect.Success<ReturnType<typeof EffectOpenCode.make>>

declare const effectClient: EffectClient

const effectApi: EffectApi<unknown> = effectClient

void effectApi
