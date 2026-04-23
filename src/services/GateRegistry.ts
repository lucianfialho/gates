import { Context, Effect, Layer } from "effect"
import type { Gate, GateError, ToolCall } from "../gates/Gate.js"

export interface GateRegistryShape {
  readonly register: (gate: Gate) => void
  readonly enforce: (call: ToolCall) => Effect.Effect<void, GateError>
}

export class GateRegistry extends Context.Service<GateRegistry, GateRegistryShape>()(
  "gates/GateRegistry"
) {}

const makeImpl = (): GateRegistryShape => {
  const gates: Gate[] = []
  return {
    register: (gate) => { gates.push(gate) },
    enforce: (call) => {
      const matching = gates.filter((g) => g.matches(call))
      if (!matching.length) return Effect.succeed(undefined)
      return Effect.forEach(matching, (g) => g.check(call), { concurrency: 1, discard: true })
    },
  }
}

export const GateRegistryLayer: Layer.Layer<GateRegistry> = Layer.sync(GateRegistry)(makeImpl)
