import { Effect, Layer } from "effect"
import { readFile, readdir } from "node:fs/promises"
import { resolve, join } from "node:path"
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
    Effect.tap(({ text }) => Effect.sync(() => console.log(text || "(task completed — agent returned no text)"))),
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

const runStats = async () => {
  const runsDir = join(process.cwd(), ".gates", "runs")
  let files: string[]
  try {
    files = (await readdir(runsDir)).filter((f) => f.endsWith(".jsonl"))
  } catch {
    console.log("No runs yet. Run: gates <prompt>")
    return
  }

  type Row = { ts: string; prompt: string; tin: number; tout: number; cost: number }
  const rows: Row[] = []

  for (const file of files) {
    const lines = (await readFile(join(runsDir, file), "utf-8")).split("\n").filter(Boolean)
    const parsed = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } }).filter(Boolean)
    const start = parsed.find((e) => e!.type === "run_start") as { prompt: string; ts: string } | undefined
    const complete = parsed.find((e) => e!.type === "run_complete") as { total_input_tokens: number; total_output_tokens: number } | undefined
    if (!start || !complete) continue
    const tin = Number(complete.total_input_tokens) || 0
    const tout = Number(complete.total_output_tokens) || 0
    if (tin === 0 && tout === 0) continue
    // Sonnet 4.6: $3/MTok in, $15/MTok out
    const cost = (tin / 1_000_000) * 3 + (tout / 1_000_000) * 15
    rows.push({ ts: start.ts, prompt: start.prompt.slice(0, 55).replace(/\n/g, " "), tin, tout, cost })
  }

  rows.sort((a, b) => a.ts.localeCompare(b.ts))

  const totalIn = rows.reduce((s, r) => s + r.tin, 0)
  const totalOut = rows.reduce((s, r) => s + r.tout, 0)
  const totalCost = rows.reduce((s, r) => s + r.cost, 0)

  console.log(`\n${"date".padEnd(12)} ${"in tok".padStart(8)} ${"out tok".padStart(8)} ${"cost $".padStart(8)}  prompt`)
  console.log("─".repeat(90))
  for (const r of rows) {
    const date = r.ts.slice(0, 10)
    console.log(`${date.padEnd(12)} ${String(r.tin).padStart(8)} ${String(r.tout).padStart(8)} ${r.cost.toFixed(4).padStart(8)}  ${r.prompt}`)
  }
  console.log("─".repeat(90))
  console.log(`${"TOTAL".padEnd(12)} ${String(totalIn).padStart(8)} ${String(totalOut).padStart(8)} ${totalCost.toFixed(4).padStart(8)}`)
  console.log()
}

const main = async () => {
  if (cmd === "stats") {
    await runStats()
    return
  }

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
      "Usage:\n  gates <prompt>\n  gates run <skill.yaml> [key=value ...]\n  gates stats\n  gates auth set <key>\n  gates auth show\n  gates auth remove"
    )
    process.exit(1)
  }

  await Effect.runPromise(await runAgent(prompt))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
