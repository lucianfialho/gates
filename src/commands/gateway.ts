#!/usr/bin/env bun
import { Effect, Layer } from "effect"
import { join, resolve } from "node:path"
import { access } from "node:fs/promises"
import { createInterface } from "node:readline/promises"

import { LLMLayer } from "../services/LLM.js"
import { GateRegistryLayer } from "../services/GateRegistry.js"
import { ToolRegistryLayer } from "../services/Tools.js"
import { BuiltinGatesLayer } from "../gates/builtin.js"
import { PersistenceLayer } from "../machine/Persistence.js"
import { GatewayService, GatewayServiceLive } from "../machine/Gateway.js"
import { run } from "../agent/Loop.js"
import { runSkill } from "../machine/Runner.js"
import { updateContextFile } from "../context/ProjectContext.js"

const AppLayer = Layer.mergeAll(
  LLMLayer,
  GateRegistryLayer,
  ToolRegistryLayer,
  PersistenceLayer,
  BuiltinGatesLayer.pipe(Layer.provide(GateRegistryLayer)),
  GatewayServiceLive.pipe(Layer.provide(LLMLayer))
)

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

export const runGateway = async (prompt: string, systemPrompt: string | undefined, verbose?: boolean) => {
  const skillsDir = join(process.cwd(), "skills")
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
