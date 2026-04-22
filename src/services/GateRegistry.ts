import { Context, Effect, Layer } from "effect"
import type { Gate, GateError, ToolCall } from "../gates/Gate.js"

export interface GateRegistryShape {
  readonly register: (gate: Gate) => void
  readonly enforce: (call: ToolCall) => Effect.Effect<void, GateError>
}

export class GateRegistry extends Context.Service<GateRegistry, GateRegistryShape>()(
  "gates/GateRegistry"
) {}

const makeImpl: Effect.Effect<GateRegistryShape> = Effect.sync(() => {
  const gates: Gate[] = []

  const register = (gate: Gate): void => {
    gates.push(gate)
  }

  const enforce = (call: ToolCall): Effect.Effect<void, GateError> =>
    Effect.forEach(
      gates.filter((g) => g.matches(call)),
      (g) => g.check(call),
      { concurrency: 1, discard: true }
    )

  return { register, enforce }
})

export const GateRegistryLayer = Layer.effect(GateRegistry)(makeImpl)
