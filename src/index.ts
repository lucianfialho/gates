import { Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { LLMLayer } from "./services/LLM.js"
import { GateRegistryLayer } from "./services/GateRegistry.js"
import { ToolRegistryLayer } from "./services/Tools.js"
import { BuiltinGatesLayer } from "./gates/builtin.js"
import { PersistenceLayer } from "./machine/Persistence.js"
import { Auth, AuthLayer } from "./auth/Auth.js"
import { run } from "./agent/Loop.js"
import { runSkill } from "./machine/Runner.js"

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
    Effect.tap((result) => Effect.sync(() => console.log(result || "(task completed — agent returned no text)"))),
    Effect.provide(AppLayer)
  )
}

const parseKvArgs = (args: string[]): Record<string, string> =>
  Object.fromEntries(
    args.flatMap((a) => {
      const idx = a.indexOf("=")
      return idx > 0 ? [[a.slice(0, idx), a.slice(idx + 1)]] : []
    })
  )

const main = async () => {
  if (cmd === "auth") {
    await Effect.runPromise(runAuth(rest))
    return
  }

  if (cmd === "run") {
    const [skillPath, ...kvArgs] = rest
    if (!skillPath) {
      console.error("Usage: gates run <skill.yaml> [key=value ...]")
      process.exit(1)
    }
    const jsonMode = kvArgs.includes('--json')
    const filteredKvArgs = kvArgs.filter(a => a !== '--json')
    const inputs = parseKvArgs(filteredKvArgs)
    const systemPrompt = await loadContext()
    const effect = runSkill(resolve(skillPath), inputs, systemPrompt).pipe(
      Effect.tap((results) =>
        Effect.sync(() => {
          const states = Object.keys(results)
          const last = states[states.length - 1]
          if (last) {
            if (jsonMode) {
              process.stdout.write(JSON.stringify(results[last]?.output) + '\n')
            } else {
              console.log(JSON.stringify(results[last]?.output, null, 2))
            }
          }
        })
      ),
      Effect.provide(AppLayer)
    )
    await Effect.runPromise(effect)
    return
  }

  const prompt = cmd ? [cmd, ...rest].join(" ") : ""
  if (!prompt) {
    console.log(
      "Usage:\n  gates <prompt>\n  gates run <skill.yaml> [key=value ...]\n  gates auth set <key>\n  gates auth show\n  gates auth remove"
    )
    process.exit(1)
  }

  await Effect.runPromise(await runAgent(prompt))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
