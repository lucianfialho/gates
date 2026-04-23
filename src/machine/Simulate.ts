import { readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { load } from "js-yaml"
import type { Skill, StateDef } from "./Skill.js"

// Generates a minimal stub output that passes the output_schema required fields
const stubOutput = async (stateDef: StateDef, skillDir: string): Promise<Record<string, unknown>> => {
  if (!stateDef.output_schema) return { result: "stub" }
  try {
    const raw = await readFile(join(skillDir, stateDef.output_schema), "utf-8")
    const schema = JSON.parse(raw) as { required?: string[]; properties?: Record<string, { type?: string; enum?: unknown[] }> }
    const stub: Record<string, unknown> = {}
    for (const key of schema.required ?? []) {
      const prop = schema.properties?.[key]
      if (prop?.enum) { stub[key] = prop.enum[0]; continue }
      switch (prop?.type) {
        case "boolean": stub[key] = true; break
        case "array":   stub[key] = []; break
        case "number":  stub[key] = 0; break
        default:        stub[key] = `<${key}>`
      }
    }
    return stub
  } catch {
    return { result: "stub" }
  }
}

interface SimStep {
  state: string
  output: Record<string, unknown>
  next: string | null
  hitl: boolean
  timeout_ms: number | null
  on_error_state: string | null
}

export const simulate = async (skillPath: string, inputs: Record<string, string> = {}): Promise<void> => {
  const raw = await readFile(skillPath, "utf-8")
  const skill = load(raw) as Skill
  const skillDir = dirname(skillPath)

  console.log(`\n${"═".repeat(60)}`)
  console.log(`SIMULATE: ${skill.id} (${skillPath})`)
  if (skill.description) console.log(skill.description.trim())
  console.log(`Inputs: ${JSON.stringify(inputs)}`)
  console.log("═".repeat(60))

  const steps: SimStep[] = []
  const stateNames = Object.keys(skill.states)
  let currentState = skill.initial_state
  const visited = new Set<string>()
  let step = 0

  while (step++ < 30) {
    if (visited.has(currentState)) {
      console.log(`\n⚠ Loop detected at state: ${currentState}`)
      break
    }
    visited.add(currentState)

    const stateDef = skill.states[currentState]
    if (!stateDef) { console.log(`\n✗ Unknown state: ${currentState}`); break }
    if (stateDef.terminal) {
      steps.push({ state: currentState, output: {}, next: null, hitl: false, timeout_ms: null, on_error_state: null })
      break
    }

    const output = await stubOutput(stateDef, skillDir)
    const currentIdx = stateNames.indexOf(currentState)
    const nextLinear = stateNames[currentIdx + 1]

    // Resolve transition with stub output
    let next = nextLinear ?? null
    for (const t of stateDef.transitions ?? []) {
      if (!t.when) { next = t.to; break }
      const match = /^([\w.]+)\s*(==|!=)\s*(.+)$/.exec(t.when.trim())
      if (!match) { next = t.to; break }
      const [, fieldPath, op, expected] = match as unknown as [string, string, string, string]
      const actual = fieldPath.split(".").reduce<unknown>((obj, k) => (obj as Record<string, unknown>)?.[k], output)
      const matches = op === "==" ? String(actual) === expected.trim() : String(actual) !== expected.trim()
      if (matches) { next = t.to; break }
    }

    steps.push({
      state: currentState,
      output,
      next,
      hitl: stateDef.hitl_pause ?? false,
      timeout_ms: stateDef.timeout_ms ?? null,
      on_error_state: stateDef.on_error_state ?? null,
    })

    if (!next) break
    currentState = next
  }

  // Print trace
  for (const s of steps) {
    const terminal = s.next === null
    const icon = terminal ? "◉" : "○"
    console.log(`\n${icon} ${s.state}`)
    if (!terminal) {
      console.log(`  stub output: ${JSON.stringify(s.output)}`)
      if (s.hitl)                console.log(`  ✋ HITL pause — human approval required`)
      if (s.timeout_ms !== null) console.log(`  ⏱ timeout: ${s.timeout_ms}ms`)
      if (s.on_error_state)      console.log(`  ⚡ on error → ${s.on_error_state}`)
      console.log(`  → ${s.next}`)
    }
  }

  console.log(`\n${"═".repeat(60)}`)
  console.log(`${steps.length} states traced. No LLM calls made.`)
  console.log("═".repeat(60) + "\n")
}
