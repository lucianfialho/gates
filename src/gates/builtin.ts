import { Effect, Layer } from "effect"
import { GateRegistry } from "../services/GateRegistry.js"
import { bashSafetyGate } from "./BashSafety.js"
import { metadataGate } from "./Metadata.js"

export const BuiltinGatesLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* GateRegistry
    registry.register(bashSafetyGate)
    registry.register(metadataGate)
  })
)
