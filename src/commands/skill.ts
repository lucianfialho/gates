#!/usr/bin/env bun
import { Effect, Layer } from "effect"
import { readFile, readdir } from "node:fs/promises"
import { resolve, join } from "node:path"
import { access } from "node:fs/promises"

import { LLMLayer } from "../services/LLM.js"
import { GateRegistryLayer } from "../services/GateRegistry.js"
import { ToolRegistryLayer } from "../services/Tools.js"
import { BuiltinGatesLayer } from "../gates/builtin.js"
import { PersistenceLayer } from "../machine/Persistence.js"
import { GatewayService, GatewayServiceLive } from "../machine/Gateway.js"

const AppLayer = Layer.mergeAll(
  LLMLayer,
  GateRegistryLayer,
  ToolRegistryLayer,
  PersistenceLayer,
  BuiltinGatesLayer.pipe(Layer.provide(GateRegistryLayer)),
  GatewayServiceLive.pipe(Layer.provide(LLMLayer))
)

const parseKvArgs = (args: string[]): Record<string, string> =>
  Object.fromEntries(
    args.flatMap((a) => {
      const idx = a.indexOf("=")
      return idx > 0 ? [[a.slice(0, idx), a.slice(idx + 1)]] : []
    })
  )

const runSkill = async (skillPath: string, kvArgs: string[], verbose?: boolean, cliHITL?: (state: string, output: unknown) => Promise<boolean>) => {
  const jsonMode = kvArgs.includes("--json")
  const filteredKvArgs = kvArgs.filter(a => a !== "--json")
  const inputs = parseKvArgs(filteredKvArgs)
  const { runSkill: runSkillFn } = await import("../machine/Runner.js")
  const effect = runSkillFn(resolve(skillPath), inputs, undefined, verbose, cliHITL).pipe(
    Effect.tap((results) =>
      Effect.sync(() => {
        const states = Object.keys(results)
        const last = states[states.length - 1]
        if (last) {
          if (jsonMode) {
            process.stdout.write(JSON.stringify(results[last]?.output) + "\n")
          } else {
            console.log(JSON.stringify(results[last]?.output, null, 2))
          }
        }
      })
    ),
    Effect.provide(AppLayer)
  )
  await Effect.runPromise(effect as any)
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

import { createInterface } from "node:readline/promises"

export const runSkillShortcut = async (cmd: string, rest: string[], verbose?: boolean) => {
  const skillShortcut = join(process.cwd(), "skills", cmd ?? "", "skill.yaml")
  if (!cmd || !(await access(skillShortcut).then(() => true).catch(() => false))) {
    return null  // Not a skill shortcut
  }
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
  await runSkill(skillShortcut, kvArgs, verbose, cliHITL)
  return true  // Handled
}

export const runSkillByPath = async (skillPath: string, rest: string[], verbose?: boolean) => {
  if (!skillPath) {
    console.error("Usage: gates run <skill.yaml> [key=value ...]")
    process.exit(1)
  }
  await runSkill(resolve(skillPath), rest, verbose, cliHITL)
}
