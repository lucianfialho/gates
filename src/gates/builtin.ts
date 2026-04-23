import { Effect, Layer } from "effect"
import { GateRegistry } from "../services/GateRegistry.js"
import { Logger, LoggerLayer } from "../services/Logger.js"
import { bashSafetyGate } from "./BashSafety.js"
import { metadataGate } from "./Metadata.js"

export const BuiltinGatesLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const logger = yield* Logger
    const registry = yield* GateRegistry
    registry.register(bashSafetyGate)
    registry.register(metadataGate)
    logger.info("Built-in gates registered", { gate: "bash-safety, metadata" })
  })
).pipe(Layer.provide(LoggerLayer))
