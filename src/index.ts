import { Effect, Layer } from "effect"
import { LLMLayer } from "./services/LLM.js"
import { GateRegistryLayer } from "./services/GateRegistry.js"
import { ToolRegistryLayer } from "./services/Tools.js"
import { BuiltinGatesLayer } from "./gates/builtin.js"
import { PersistenceLayer } from "./machine/Persistence.js"
import { run } from "./agent/Loop.js"

const prompt = process.argv.slice(2).join(" ")

if (!prompt) {
  console.error("Usage: gates <prompt>")
  process.exit(1)
}

const AppLayer = Layer.mergeAll(
  LLMLayer,
  GateRegistryLayer,
  ToolRegistryLayer,
  PersistenceLayer,
  BuiltinGatesLayer.pipe(Layer.provide(GateRegistryLayer))
)

const program = run(prompt).pipe(
  Effect.tap((result) => Effect.sync(() => console.log(result))),
  Effect.provide(AppLayer)
)

Effect.runPromise(program).catch((e) => {
  console.error(e)
  process.exit(1)
})
