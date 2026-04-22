import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { load } from "js-yaml"

export interface InputDef {
  name: string
  type: "string" | "integer" | "number" | "boolean"
}

export interface Transition {
  to: string
  when?: string  // "output.field == value" — evaluated against state output
}

export interface StateDef {
  description?: string
  agent_prompt: string
  output_schema?: string  // path to JSON Schema file (relative to skill dir)
  terminal?: boolean
  transitions?: Transition[]
  on_error?: "retry" | "skip" | "abort"  // default: abort
  max_retries?: number  // used when on_error = retry, default 2
}

export interface Skill {
  id: string
  version: 1
  description?: string
  initial_state: string
  inputs?: { required?: InputDef[] }
  states: Record<string, StateDef>
}

export class SkillError {
  readonly _tag = "SkillError"
  constructor(readonly reason: string) {}
}

export const loadSkill = (path: string): Effect.Effect<Skill, SkillError> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile(path, "utf-8")
      return load(raw) as Skill
    },
    catch: (e) => new SkillError(`Failed to load skill at ${path}: ${e}`),
  })

// Interpolates {{inputs.foo}}, {{outputs.state_id.field}} in agent_prompt
export const interpolate = (
  template: string,
  ctx: { inputs: Record<string, string>; outputs: Record<string, unknown> }
): string =>
  template.replace(/\{\{([\w.]+)\}\}/g, (_, key: string) => {
    const parts = key.split(".")
    if (parts[0] === "inputs" && parts[1]) {
      return ctx.inputs[parts[1]] ?? `{{${key}}}`
    }
    if (parts[0] === "outputs" && parts[1]) {
      const stateOutput = ctx.outputs[parts[1]] as Record<string, unknown> | undefined
      if (parts[2] && stateOutput) {
        return String(stateOutput[parts[2]] ?? `{{${key}}}`)
      }
    }
    return `{{${key}}}`
  })

// Resolves which transition to take based on state output.
// First matching transition wins. If no conditions, first transition is taken.
export const resolveTransition = (
  stateDef: StateDef,
  output: unknown,
  fallback: string | undefined
): Effect.Effect<string, SkillError> => {
  const transitions = stateDef.transitions ?? []

  if (transitions.length === 0) {
    return fallback
      ? Effect.succeed(fallback)
      : Effect.fail(new SkillError(`State has no transitions and no fallback`))
  }

  for (const t of transitions) {
    if (!t.when) return Effect.succeed(t.to)

    // simple evaluation: "field == value" or "field != value"
    const match = /^([\w.]+)\s*(==|!=)\s*(.+)$/.exec(t.when.trim())
    if (!match) return Effect.succeed(t.to)  // unparseable → take it

    const [, fieldPath, op, expected] = match as unknown as [string, string, string, string]
    const actual = fieldPath.split(".").reduce<unknown>(
      (obj, k) => (obj as Record<string, unknown>)?.[k],
      output
    )
    const matches =
      op === "==" ? String(actual) === expected.trim() :
      op === "!=" ? String(actual) !== expected.trim() : false

    if (matches) return Effect.succeed(t.to)
  }

  // no condition matched — take unconditional fallback or first
  const unconditional = transitions.find((t) => !t.when)
  return unconditional
    ? Effect.succeed(unconditional.to)
    : Effect.fail(new SkillError(`No transition matched for state output: ${JSON.stringify(output)}`))
}
