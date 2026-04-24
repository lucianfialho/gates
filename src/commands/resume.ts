#!/usr/bin/env bun
import { Effect, Layer } from "effect"
import { readFile, readdir } from "node:fs/promises"
import { resolve, join } from "node:path"
import { access } from "node:fs/promises"
import { createInterface } from "node:readline/promises"

import { LLMLayer } from "../services/LLM.js"
import { GateRegistryLayer } from "../services/GateRegistry.js"
import { ToolRegistryLayer } from "../services/Tools.js"
import { BuiltinGatesLayer } from "../gates/builtin.js"
import { PersistenceLayer } from "../machine/Persistence.js"
import { GatewayService, GatewayServiceLive } from "../machine/Gateway.js"

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

const AppLayer = Layer.mergeAll(
  LLMLayer,
  GateRegistryLayer,
  ToolRegistryLayer,
  PersistenceLayer,
  BuiltinGatesLayer.pipe(Layer.provide(GateRegistryLayer)),
  GatewayServiceLive.pipe(Layer.provide(LLMLayer))
)

export const runResume = async (runIdPrefix: string, verbose?: boolean) => {
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
  const skillPath = join(process.cwd(), "skills", skillName.replace(/^skill:/, ""), "skill.yaml")

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

  const effect = await import("../machine/Runner.js").then(m =>
    m.runSkill(resolve(skillPath), { ...recoveredInputs, initial_state_override: failedState }, undefined, verbose, cliHITL, undefined, resumeOutputs).pipe(
      Effect.tap((results) => Effect.sync(() => {
        const last = Object.values(results).at(-1)
        if (last) console.log(JSON.stringify(last.output, null, 2))
      })),
      Effect.provide(AppLayer)
    )
  )
  await Effect.runPromise(effect as any)
}
