#!/usr/bin/env bun
import { Effect, Layer } from "effect"
import { readFile, readdir, access } from "node:fs/promises"
import { resolve, join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline/promises"

import { LLMLayer } from "./services/LLM.js"
import { GateRegistryLayer } from "./services/GateRegistry.js"
import { ToolRegistryLayer } from "./services/Tools.js"
import { BuiltinGatesLayer } from "./gates/builtin.js"
import { PersistenceLayer } from "./machine/Persistence.js"
import { Auth, AuthLayer } from "./auth/Auth.js"
import { run } from "./agent/Loop.js"
import { runSkill } from "./machine/Runner.js"
import { simulate } from "./machine/Simulate.js"
import { updateContextFile } from "./context/ProjectContext.js"
import { startChat } from "./chat/index.js"
import { GatewayService, GatewayServiceLive } from "./machine/Gateway.js"
import { getBudget } from "./config/GatesConfig.js"

const rawArgs = process.argv.slice(2)
const verbose = rawArgs.includes("--verbose")
const filteredArgs = rawArgs.filter((a) => a !== "--verbose")
const [cmd, ...rest] = filteredArgs

const AppLayer = Layer.mergeAll(
  LLMLayer,
  GateRegistryLayer,
  ToolRegistryLayer,
  PersistenceLayer,
  BuiltinGatesLayer.pipe(Layer.provide(GateRegistryLayer)),
  GatewayServiceLive.pipe(Layer.provide(LLMLayer))
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
    const [sub, second, third] = args

    if (sub === "set") {
      // gates auth set <key>               → anthropic (default)
      // gates auth set <provider> <key>    → named provider
      const [provider, key] = third ? [second!, third] : ["anthropic", second!]
      if (!key) {
        console.error("Usage:\n  gates auth set <key>\n  gates auth set <provider> <key>")
        process.exit(1)
      }
      yield* auth.setApiKey(key, provider)
      console.log(`API key saved for "${provider}" in ~/.local/share/gates/auth.json`)
      return
    }

    if (sub === "show") {
      const keys = yield* auth.listKeys()
      const entries = Object.entries(keys)
      if (!entries.length) {
        console.log("No API keys stored.\n  Run: gates auth set <key>")
        return
      }
      console.log("\nStored API keys:")
      for (const [p, k] of entries) console.log(`  ${p.padEnd(12)} ${k}`)
      console.log()
      return
    }

    if (sub === "remove") {
      // gates auth remove             → anthropic
      // gates auth remove <provider>  → named provider
      const provider = second ?? "anthropic"
      yield* auth.removeApiKey(provider)
      console.log(`API key removed for "${provider}".`)
      return
    }

    console.log("Usage:\n  gates auth set <key>\n  gates auth set <provider> <key>\n  gates auth show\n  gates auth remove [provider]")
  }).pipe(Effect.provide(AuthLayer))

const runAgent = async (prompt: string, verbose?: boolean) => {
  const systemPrompt = await loadContext()
  return run(prompt, systemPrompt, undefined, verbose).pipe(
    Effect.tap(({ text }) => Effect.sync(() => console.log(text || "(task completed — agent returned no text)"))),
    Effect.tap(() => Effect.promise(() => updateContextFile())),
    Effect.provide(AppLayer)
  )
}

const cliHITL = async (state: string, output: unknown): Promise<boolean> => {
  console.log(`\n${"─".repeat(60)}`)
  console.log(`[gates] ✋ HITL pause after: ${state}`)
  console.log(JSON.stringify(output, null, 2))
  console.log("─".repeat(60))
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question("\nProceed with this plan? [Y/n] ")
  rl.close()
  const proceed = !answer.trim() || answer.trim().toLowerCase().startsWith("y")
  if (!proceed) console.log("[gates] Plan rejected — skill aborted.")
  return proceed
}

// Log formatting utilities
const truncate = (s: unknown, max = 60): { value: string; originalLength: number } => {
  const str = typeof s === "string" ? s : JSON.stringify(s)
  return { value: str.length > max ? str.slice(0, max) + "…" : str, originalLength: str.length }
}
const ANSI = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", blue: "\x1b[34m", dim: "\x1b[2m" }
const colorize = (type: string, text: string): string => {
  const c = type.includes("pass") || type.includes("complete") ? ANSI.green :
            type.includes("block") || type.includes("fail") ? ANSI.red :
            type.includes("request") || type.includes("call") ? ANSI.yellow :
            type.includes("response") || type.includes("result") ? ANSI.blue : ANSI.dim
  return `${c}${text}${ANSI.reset}`
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
  const outputJson = rawArgs.includes("--json") || rest.includes("--json")

  try {
    files = (await readdir(runsDir)).filter((f) => f.endsWith(".jsonl"))
  } catch {
    console.log("No runs yet. Run: gates <prompt>")
    return
  }

  type Row = { ts: string; prompt: string; tin: number; tout: number; cost: number }
  const rows: Row[] = []
  let totalCacheHits = 0
  let totalCacheInvalidations = 0
  let totalTokensCached = 0

  for (const file of files) {
    const lines = (await readFile(join(runsDir, file), "utf-8")).split("\n").filter(Boolean)
    const parsed = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } }).filter(Boolean)
    const start = parsed.find((e) => e!.type === "run_start") as { prompt: string; ts: string; parentRunId?: string } | undefined
    const complete = parsed.find((e) => e!.type === "run_complete") as { total_input_tokens: number; total_output_tokens: number } | undefined
    const cacheMetrics = parsed.find((e) => e!.type === "cache_metrics") as { metrics: { cache_hits: number; cache_invalidations: number; tokens_cached: number } } | undefined
    if (!start || !complete) continue
    if (start.parentRunId) continue  // sub-run of a skill — skip, already counted in parent
    const tin = Number(complete.total_input_tokens) || 0
    const tout = Number(complete.total_output_tokens) || 0
    if (tin === 0 && tout === 0) continue
    // Sonnet 4.6: $3/MTok in, $15/MTok out
    const cost = (tin / 1_000_000) * 3 + (tout / 1_000_000) * 15
    const label = start.prompt.startsWith("skill:")
      ? (start.prompt.split(" inputs:")[0] ?? start.prompt)
      : start.prompt.slice(0, 55).replace(/\n/g, " ")
    rows.push({ ts: start.ts, prompt: label, tin, tout, cost })

    // Accumulate cache metrics
    if (cacheMetrics?.metrics) {
      totalCacheHits += cacheMetrics.metrics.cache_hits || 0
      totalCacheInvalidations += cacheMetrics.metrics.cache_invalidations || 0
      totalTokensCached += cacheMetrics.metrics.tokens_cached || 0
    }
  }

  rows.sort((a, b) => a.ts.localeCompare(b.ts))

  const totalIn = rows.reduce((s, r) => s + r.tin, 0)
  const totalOut = rows.reduce((s, r) => s + r.tout, 0)
  const totalCost = rows.reduce((s, r) => s + r.cost, 0)

  // Filter to current calendar month for budget bar
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth()
  const monthlyRows = rows.filter(r => {
    const d = new Date(r.ts)
    return d.getFullYear() === currentYear && d.getMonth() === currentMonth
  })
  const monthlyCost = monthlyRows.reduce((s, r) => s + r.cost, 0)

  if (outputJson) {
    const output = {
      rows: rows.map(r => ({ ts: r.ts, prompt: r.prompt, tin: r.tin, tout: r.tout, cost: r.cost })),
      totals: { tin: totalIn, tout: totalOut, cost: totalCost },
      cache_metrics: { cache_hits: totalCacheHits, cache_invalidations: totalCacheInvalidations, tokens_cached: totalTokensCached }
    }
    console.log(JSON.stringify(output))
    return
  }

  // Budget bar (hidden when budget is 0 or in --json mode)
  const budget = await getBudget()
  if (budget > 0) {
    const filled = Math.floor((monthlyCost / budget) * 20)
    const bar = "=".repeat(filled) + ".".repeat(Math.max(0, 20 - filled))
    console.log(` [${monthlyCost.toFixed(2)} / ${budget.toFixed(2)} ] [${bar}]`)
  }

  console.log(`\n${"date".padEnd(12)} ${"in tok".padStart(8)} ${"out tok".padStart(8)} ${"cost $".padStart(8)}  prompt`)
  console.log("─".repeat(90))
  for (const r of rows) {
    const date = r.ts.slice(0, 10)
    console.log(`${date.padEnd(12)} ${String(r.tin).padStart(8)} ${String(r.tout).padStart(8)} ${r.cost.toFixed(4).padStart(8)}  ${r.prompt}`)
  }
  console.log("─".repeat(90))
  console.log(`${"TOTAL".padEnd(12)} ${String(totalIn).padStart(8)} ${String(totalOut).padStart(8)} ${totalCost.toFixed(4).padStart(8)}`)

  // Print cache metrics if available
  if (totalCacheHits > 0 || totalCacheInvalidations > 0 || totalTokensCached > 0) {
    console.log("\nCache Metrics:")
    console.log(`  cache_hits:          ${totalCacheHits}`)
    console.log(`  cache_invalidations: ${totalCacheInvalidations}`)
    console.log(`  tokens_cached:       ${totalTokensCached}`)
  }
  console.log()
}

const runLogs = async (runId?: string) => {
  const runsDir = join(process.cwd(), ".gates", "runs")
  let files: string[]
  try {
    files = (await readdir(runsDir)).filter((f) => f.endsWith(".jsonl"))
  } catch {
    console.log("No runs yet. Run: gates <prompt>")
    return
  }

  if (runId) {
    // Locate file by full id or prefix match
    const match = files.find((f) => f === `${runId}.jsonl` || f.startsWith(runId))
    if (!match) {
      console.error(`No run found matching: ${runId}`)
      process.exit(1)
    }
    const lines = (await readFile(join(runsDir, match), "utf-8")).split("\n").filter(Boolean)
    const events = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } }).filter(Boolean)
    console.log(`\nRun: ${match.replace(".jsonl", "")}`)
    console.log("─".repeat(100))
    console.log(`${"timestamp".padEnd(28)} ${"event".padEnd(15)} ${"gate".padEnd(20)} ${"tool".padEnd(15)} duration`)
    console.log("─".repeat(100))
    for (const ev of events) {
      const rawTs = ev!.ts as string ?? ""
      const timestamp = rawTs.length >= 19 ? rawTs : ""
      const type = String(ev!.type ?? "unknown")
      const gate = String(ev!.gate ?? "")
      const tool = String(ev!.tool ?? "")
      const duration = ev!.duration !== undefined ? `${ev!.duration}ms` : ""

      let detail = ""
      if (type === "run_start") {
        const { value, originalLength } = truncate(ev!.prompt, 60)
        detail = `prompt="${value}"${originalLength > 60 ? ` [${originalLength} chars]` : ""}`
      } else if (type === "run_complete") {
        detail = `input_tokens=${ev!.total_input_tokens} output_tokens=${ev!.total_output_tokens}`
      } else if (type === "llm_response") {
        detail = `stop_reason=${ev!.stop_reason} input_tokens=${ev!.input_tokens} output_tokens=${ev!.output_tokens}`
      } else if (type === "gate_block") {
        const { value, originalLength } = truncate(ev!.reason, 60)
        detail = `reason="${value}"${originalLength > 60 ? ` [${originalLength} chars]` : ""}`
      } else if (type === "tool_result") {
        const { value, originalLength } = truncate(ev!.content, 60)
        detail = `content="${value}"${originalLength > 60 ? ` [${originalLength} chars]` : ""}`
      } else if (type === "cache_metrics") {
        detail = `cache_hits=${ev!.cache_hits} cache_invalidations=${ev!.cache_invalidations} tokens_cached=${ev!.tokens_cached}`
      } else {
        // Render remaining fields except type, ts, and known fields
        const rest2 = Object.entries(ev!).filter(([k]) => !["type", "ts", "gate", "tool", "duration"].includes(k))
        const { value, originalLength } = truncate(rest2.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" "), 60)
        detail = `${value}${originalLength > 60 ? ` [${originalLength} chars]` : ""}`
      }

      const line = [
        timestamp.padEnd(28),
        colorize(type, type.padEnd(15)),
        gate.padEnd(20),
        tool.padEnd(15),
        duration,
        detail,
      ].join(" ")
      console.log(line)
    }
    console.log("─".repeat(100))
    console.log()
    return
  }

  // List mode — last 10 runs
  type RunRow = { ts: string; id: string; tin: number; tout: number; prompt: string }
  const rows: RunRow[] = []

  for (const file of files) {
    const lines = (await readFile(join(runsDir, file), "utf-8")).split("\n").filter(Boolean)
    const parsed = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } }).filter(Boolean)
    const start = parsed.find((e) => e!.type === "run_start") as { prompt: string; ts: string } | undefined
    const complete = parsed.find((e) => e!.type === "run_complete") as { total_input_tokens: number; total_output_tokens: number } | undefined
    if (!start) continue
    const tin = complete ? Number(complete.total_input_tokens) || 0 : 0
    const tout = complete ? Number(complete.total_output_tokens) || 0 : 0
    const id = file.replace(".jsonl", "")
    const { value: prompt } = truncate(start.prompt, 50)
    rows.push({ ts: start.ts, id, tin, tout, prompt })
  }

  rows.sort((a, b) => b.ts.localeCompare(a.ts))
  const recent = rows.slice(0, 10)

  console.log(`\n${"id".padEnd(10)} ${"date".padEnd(12)} ${"in tok".padStart(8)} ${"out tok".padStart(8)}  prompt`)
  console.log("─".repeat(90))
  for (const r of recent) {
    const date = r.ts.slice(0, 16).replace("T", " ")
    console.log(`${r.id.slice(0, 8).padEnd(10)} ${date.padEnd(12)} ${String(r.tin).padStart(8)} ${String(r.tout).padStart(8)}  ${r.prompt}`)
  }
  console.log("─".repeat(90))
  console.log()
}

const main = async () => {
  if (cmd === "version") {
    console.log("0.1.0")
    return
  }

  if (cmd === "stats") {
    await runStats()
    return
  }

  if (cmd === "simulate") {
    const [skillPath, ...kvArgs] = rest
    if (!skillPath) { console.error("Usage: gates simulate <skill.yaml> [key=value ...]"); process.exit(1) }
    await simulate(resolve(skillPath), parseKvArgs(kvArgs))
    return
  }

  if (cmd === "chat") {
    const systemPrompt = await loadContext()
    await startChat(AppLayer as never, systemPrompt)
    return
  }

  if (cmd === "logs") {
    await runLogs(rest[0])
    return
  }

  if (cmd === "resume") {
    const runIdPrefix = rest[0]
    if (!runIdPrefix) { console.error("Usage: gates resume <run-id>"); process.exit(1) }

    const runsDir = join(process.cwd(), ".gates", "runs")
    const files = (await readdir(runsDir).catch(() => [])).filter(f => f.endsWith(".jsonl"))
    const match = files.find(f => f === `${runIdPrefix}.jsonl` || f.startsWith(runIdPrefix))
    if (!match) { console.error(`No run found matching: ${runIdPrefix}`); process.exit(1) }

    const lines = (await readFile(join(runsDir, match), "utf-8")).split("\n").filter(Boolean)
    const events = lines.map(l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } }).filter(Boolean)

    // Recover original inputs and skill path from run_start
    const start = events.find(e => e!.type === "run_start") as { prompt: string } | undefined
    const promptStr = start?.prompt ?? ""
    const skillMatch = /skill:([\w/-]+)/.exec(promptStr)
    const inputsMatch = /inputs:(\{.+\})$/.exec(promptStr)
    const recoveredInputs = inputsMatch?.[1] ? JSON.parse(inputsMatch[1]) as Record<string, string> : {}
    const skillName = skillMatch?.[1] ?? "solve-issue"
    const skillPath = join(__dirname, "..", "skills", skillName.replace(/^skill:/, ""), "skill.yaml")

    // Reconstruct outputs from completed states
    const resumeOutputs: Record<string, { state: string; output: unknown; agentText: string }> = {}
    let failedState = ""
    for (const ev of events) {
      if (ev!.type === "state_complete") {
        const e = ev as { state: string; output: unknown; agentText: string }
        resumeOutputs[e.state] = { state: e.state, output: e.output, agentText: e.agentText ?? "" }
      }
      if (ev!.type === "state_error") {
        failedState = (ev as { state: string }).state
      }
    }

    if (!failedState) { console.error("Run completed successfully — nothing to resume."); process.exit(0) }

    const completedStates = Object.keys(resumeOutputs)
    console.error(`[resume] run=${match.slice(0, 8)} skill=${skillName}`)
    console.error(`[resume] completed: ${completedStates.join(" → ")}`)
    console.error(`[resume] resuming at: ${failedState}`)

    const systemPrompt = await loadContext()
    const effect = runSkill(
      resolve(skillPath),
      { ...recoveredInputs, initial_state_override: failedState },
      systemPrompt,
      verbose,
      cliHITL,
      undefined,
      resumeOutputs
    ).pipe(
      Effect.tap((results) => Effect.sync(() => {
        const last = Object.values(results).at(-1)
        if (last) console.log(JSON.stringify(last.output, null, 2))
      })),
      Effect.provide(AppLayer)
    )
    await Effect.runPromise(effect as any)
    return
  }

  if (cmd === "auth") {
    await Effect.runPromise(runAuth(rest))
    return
  }

  // skill shortcuts: gates <skill-name> "value" [key=value ...]
  const skillShortcut = join(__dirname, "..", "skills", cmd ?? "", "skill.yaml")
  if (cmd && (await access(skillShortcut).then(() => true).catch(() => false))) {
    const firstArg = rest[0] ?? ""
    // If the first arg is already key=value, pass through. Otherwise detect the
    // first required input name from the skill YAML and use it as the key.
    let kvArgs: string[]
    if (firstArg.includes("=")) {
      kvArgs = rest
    } else {
      const { load: yamlLoad } = await import("js-yaml")
      const skillRaw = await readFile(skillShortcut, "utf-8").catch(() => "")
      const skillDef = yamlLoad(skillRaw) as { inputs?: { required?: Array<{ name: string }> } }
      const firstKey = skillDef?.inputs?.required?.[0]?.name ?? "issue"
      kvArgs = [`${firstKey}=${firstArg}`, ...rest.slice(1)]
    }
    const jsonMode = kvArgs.includes("--json")
    const filteredKvArgs = kvArgs.filter(a => a !== "--json")
    const inputs = parseKvArgs(filteredKvArgs)
    const systemPrompt = await loadContext()
    const effect = runSkill(resolve(skillShortcut), inputs, systemPrompt, verbose, cliHITL).pipe(
      Effect.tap((results) =>
        Effect.sync(() => {
          const states = Object.keys(results)
          const last = states[states.length - 1]
          if (last) {
            if (jsonMode) process.stdout.write(JSON.stringify(results[last]?.output) + "\n")
            else console.log(JSON.stringify(results[last]?.output, null, 2))
          }
        })
      ),
      Effect.provide(AppLayer)
    )
    await Effect.runPromise(effect as any)
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
    const effect = runSkill(resolve(skillPath), inputs, systemPrompt, verbose, cliHITL).pipe(
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
    await Effect.runPromise(effect as any)
    return
  }

  const prompt = cmd ? [cmd, ...rest].join(" ") : ""
  if (!prompt || cmd === "--help" || cmd === "help") {
    const skillsDir = join(__dirname, "..", "skills")
    const allEntries = await readdir(skillsDir).catch(() => [] as string[])
    // Only show directories that have a skill.yaml and don't start with dot
    const skills = allEntries.filter(s => !s.startsWith("."))
    const skillList = skills.map(s => `  gates ${s} "<description>"`).join("\n")
    console.log(`
gates — autonomous coding agent

USAGE
  gates [--verbose] <prompt>                        run the agent with a direct prompt
  gates [--verbose] <skill> "<description>"         run a skill
  gates [--verbose] run <skill.yaml> [key=value .]  run a skill by path
  gates chat                                        interactive TUI (like Claude Code)
  gates simulate <skill.yaml> [key=value .]         trace skill flow without LLM calls
  gates stats                                       token usage and cost per run
  gates logs                                        list last 10 runs
  gates logs <runId>                                full event timeline for a run
  gates auth set <key>                              save API key (Anthropic or OpenAI)
  gates auth show                                   show stored key (masked)
  gates auth remove                                 delete stored key
  gates help                                        show this message

FLAGS
  --verbose              log tool calls, results, state transitions
  GATES_PROVIDER=openai  use OpenAI instead of Anthropic
  GATES_MODEL=...        override model name
  GATES_BASE_URL=...     override base URL (for Ollama etc.)

SKILLS${skillList ? "\n" + skillList : "  (none installed)"}

EXAMPLES
  gates "list all TypeScript files in src/"
  gates solve-issue "add a --verbose flag to the CLI"
  gates solve-issue 42                              ← GitHub issue number
  gates write-tests "src/machine/Runner.ts"
  gates simulate skills/solve-issue/skill.yaml      ← free, no LLM
  gates chat
  GATES_PROVIDER=openai OPENAI_API_KEY=sk-... gates solve-issue 42
  gates stats
    `.trim())
    process.exit(prompt ? 0 : 1)
  }

  // Gateway: classify intent → route to the right execution mode
  const systemPrompt = await loadContext()
  const skillsDir = join(__dirname, "..", "skills")
  const defaultSkill = join(skillsDir, "solve-issue", "skill.yaml")
  const hasDefaultSkill = await access(defaultSkill).then(() => true).catch(() => false)

  const gatewayEffect = Effect.gen(function* () {
    const gateway = yield* GatewayService
    const decision = yield* gateway.classify(prompt)

    console.error(`[gateway] mode=${decision.mode} intent="${decision.intent.slice(0, 60)}"`)

    switch (decision.mode) {
      case "ProRN":
      case "LEARN": {
        // Read-only Q&A or docs — direct agent, no PR, no skill overhead
        const learnSystem = decision.mode === "LEARN"
          ? `${systemPrompt ?? ""}\n\nMode: LEARN. You are generating documentation or explanations only. Do not modify implementation files.`
          : systemPrompt
        const result = yield* run(decision.intent, learnSystem, undefined, verbose)
        console.log(result.text || "(no output)")
        yield* Effect.promise(() => updateContextFile())
        break
      }

      case "PATCH": {
        // Minor change — skip clarify+research, enter skill at analyze directly
        if (hasDefaultSkill) {
          yield* runSkill(
            resolve(defaultSkill),
            { issue: decision.intent, initial_state_override: "analyze" },
            systemPrompt,
            verbose,
            cliHITL
          ).pipe(
            Effect.tap((results) => Effect.sync(() => {
              const last = Object.values(results).at(-1)
              if (last) console.log(JSON.stringify(last.output, null, 2))
            }))
          )
        } else {
          const result = yield* run(decision.intent, systemPrompt, undefined, verbose)
          console.log(result.text || "(no output)")
          yield* Effect.promise(() => updateContextFile())
        }
        break
      }

      case "REFACTOR": {
        if (!decision.intent.trim()) {
          console.log("Usage: @refactor split <file>\nExample: @refactor split src/index.ts")
          break
        }
        // Decompose large file — use refactor-decompose skill if available
        const refactorSkill = join(skillsDir, "refactor-decompose", "skill.yaml")
        const hasRefactorSkill = yield* Effect.promise(() => access(refactorSkill).then(() => true).catch(() => false))
        if (hasRefactorSkill) {
          yield* runSkill(
            resolve(refactorSkill),
            { target: decision.intent },
            systemPrompt,
            verbose,
            cliHITL
          ).pipe(
            Effect.tap((results) => Effect.sync(() => {
              const last = Object.values(results).at(-1)
              if (last) console.log(JSON.stringify(last.output, null, 2))
            }))
          )
        } else {
          // Fallback: freeform agent with refactor system prompt
          const refactorSystem = `${systemPrompt ?? ""}\n\nMode: REFACTOR. You are decomposing a large file into smaller modules. Each output file must be < 150 lines. Do not add features — only move code.`
          const result = yield* run(decision.intent, refactorSystem, undefined, verbose)
          console.log(result.text || "(no output)")
          yield* Effect.promise(() => updateContextFile())
        }
        break
      }

      case "STANDARD":
      default: {
        // Full lifecycle — skill if available, raw agent otherwise
        if (hasDefaultSkill) {
          yield* runSkill(
            resolve(defaultSkill),
            { issue: decision.intent },
            systemPrompt,
            verbose,
            cliHITL
          ).pipe(
            Effect.tap((results) => Effect.sync(() => {
              const last = Object.values(results).at(-1)
              if (last) console.log(JSON.stringify(last.output, null, 2))
            }))
          )
        } else {
          const result = yield* run(decision.intent, systemPrompt, undefined, verbose)
          console.log(result.text || "(no output)")
          yield* Effect.promise(() => updateContextFile())
        }
        break
      }
    }
  }).pipe(Effect.provide(AppLayer))

  await Effect.runPromise(gatewayEffect as any)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
