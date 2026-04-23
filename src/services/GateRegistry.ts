import { Context, Effect, Layer, Cause, Exit } from "effect"
import type { Gate, GateError, ToolCall } from "../gates/Gate.js"
import { Logger, LoggerShape } from "./Logger.js"

export interface GateRegistryShape {
  readonly register: (gate: Gate) => void
  readonly enforce: (call: ToolCall) => Effect.Effect<void, GateError>
}

export class GateRegistry extends Context.Service<GateRegistry, GateRegistryShape>()(
  "gates/GateRegistry"
) {}

const enforceGates = (
  gates: Gate[],
  call: ToolCall,
  logger: LoggerShape
): Effect.Effect<void, GateError> => {
  let lastError: GateError | null = null
  for (const g of gates.filter((g) => g.matches(call))) {
    const t0 = Date.now()
    const exit = Effect.runSyncExit(g.check(call))
    if (exit._tag === "Success") {
      const ms = Date.now() - t0
      logger.pass(g.name, call.name, ms)
    } else {
      const e = Cause.pretty(exit.cause) as unknown as GateError
      const ms = Date.now() - t0
      logger.block(e.gate, call.name, e.reason, ms)
      lastError = e
    }
  }
  if (lastError) {
    return Effect.fail(lastError)
  }
  return Effect.succeed(undefined)
}

export const makeGateRegistry = (logger: LoggerShape): GateRegistryShape => {
  const gates: Gate[] = []

  const register = (gate: Gate): void => {
    gates.push(gate)
    logger.info(`Gate registered: ${gate.name}`, { gate: gate.name })
  }

  const enforce = (call: ToolCall): Effect.Effect<void, GateError> =>
    enforceGates(gates, call, logger)

  return { register, enforce }
}

// Base layer - uses Effect.gen to get Logger via yield* inside the layer context
const baseGateRegistryLayer = Layer.effect(GateRegistry)(
  Effect.gen(function* () {
    const logger = yield* Logger
    return makeGateRegistry(logger)
  })
)

// GateRegistryLayer depends on Logger
export const GateRegistryLayer: Layer.Layer<GateRegistry, never, Logger> = baseGateRegistryLayer