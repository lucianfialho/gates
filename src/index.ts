import { Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"
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

const loadContext = async (): Promise<string | undefined> => {
  try {
    const claude = await readFile("CLAUDE.md", "utf-8")
    return `You are an autonomous coding agent. Here is the project context:\n\n${claude}\n\nCurrent working directory: ${process.cwd()}`
  } catch {
    return undefined
  }
}

const AppLayer = Layer.mergeAll(
  LLMLayer,
  GateRegistryLayer,
  ToolRegistryLayer,
  PersistenceLayer,
  BuiltinGatesLayer.pipe(Layer.provide(GateRegistryLayer))
)

const main = async () => {
  const systemPrompt = await loadContext()

  const program = run(prompt, systemPrompt).pipe(
    Effect.tap((result) => Effect.sync(() => console.log(result))),
    Effect.provide(AppLayer)
  )

  await Effect.runPromise(program)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
