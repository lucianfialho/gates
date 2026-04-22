import { Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"
import { LLMLayer } from "./services/LLM.js"
import { GateRegistryLayer } from "./services/GateRegistry.js"
import { ToolRegistryLayer } from "./services/Tools.js"
import { BuiltinGatesLayer } from "./gates/builtin.js"
import { PersistenceLayer } from "./machine/Persistence.js"
import { Auth, AuthLayer } from "./auth/Auth.js"
import { run } from "./agent/Loop.js"

const [, , cmd, ...rest] = process.argv

const AppLayer = Layer.mergeAll(
  LLMLayer,
  GateRegistryLayer,
  ToolRegistryLayer,
  PersistenceLayer,
  BuiltinGatesLayer.pipe(Layer.provide(GateRegistryLayer))
)

const loadContext = async (): Promise<string | undefined> => {
  try {
    const claude = await readFile("CLAUDE.md", "utf-8")
    return `You are an autonomous coding agent. Here is the project context:\n\n${claude}\n\nCurrent working directory: ${process.cwd()}`
  } catch {
    return undefined
  }
}

const runAuth = (args: string[]) =>
  Effect.gen(function* () {
    const auth = yield* Auth
    const [sub, value] = args

    if (sub === "set") {
      if (!value) { console.error("Usage: gates auth set <api-key>"); process.exit(1) }
      yield* auth.setApiKey(value)
      console.log("API key saved to ~/.local/share/gates/auth.json")
      return
    }

    if (sub === "show") {
      const key = yield* auth.getApiKey()
      if (!key) { console.log("No API key stored. Run: gates auth set sk-ant-..."); return }
      console.log(`API key: ${key.slice(0, 12)}...${key.slice(-4)}`)
      return
    }

    if (sub === "remove") {
      yield* auth.removeApiKey()
      console.log("API key removed.")
      return
    }

    console.log("Usage:\n  gates auth set <key>\n  gates auth show\n  gates auth remove")
  }).pipe(Effect.provide(AuthLayer))

const runAgent = async (prompt: string) => {
  const systemPrompt = await loadContext()
  return run(prompt, systemPrompt).pipe(
    Effect.tap((result) => Effect.sync(() => console.log(result))),
    Effect.provide(AppLayer)
  )
}

const main = async () => {
  if (cmd === "auth") {
    await Effect.runPromise(runAuth(rest))
    return
  }

  const prompt = cmd ? [cmd, ...rest].join(" ") : ""
  if (!prompt) {
    console.log("Usage:\n  gates <prompt>\n  gates auth set <key>\n  gates auth show\n  gates auth remove")
    process.exit(1)
  }

  await Effect.runPromise(await runAgent(prompt))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
