import { Effect, Context, Layer } from "effect"
import { readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { loadSkill, interpolate, resolveTransition, type Skill, SkillError } from "./Skill.js"
import { Persistence } from "./Persistence.js"
import { run as runAgent, type RunResult } from "../agent/Loop.js"
import { LLMService } from "../services/LLM.js"
import { GateRegistry } from "../services/GateRegistry.js"
import { ToolRegistry } from "../services/Tools.js"
import { AgentError } from "../agent/Loop.js"
import { GateError } from "../gates/Gate.js"
import { buildContextPrompt, updateContextFile } from "../context/ProjectContext.js"

export class RunnerError {
  readonly _tag = "RunnerError"
  constructor(readonly reason: string, readonly cause?: unknown) {}
}

type RunnerDeps = LLMService | GateRegistry | ToolRegistry | Persistence

interface StateResult {
  state: string
  output: unknown
  agentText: string
}

const loadOutputSchema = async (
  schemaPath: string,
  skillDir: string
): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await readFile(join(skillDir, schemaPath), "utf-8")
    return JSON.parse(raw) as Record<string, unknown>
  } catch { return null }
}

const extractJSON = (text: string): unknown | null => {
  const match = /```json\s*([\s\S]+?)\s*```|(\{[\s\S]+\})/.exec(text)
  if (!match) return null
  try { return JSON.parse((match[1] ?? match[2])!) } catch { return null }
}

export const runSkill = (
  skillPath: string,
  inputs: Record<string, string> = {},
  systemContext?: string,
  verbose?: boolean
): Effect.Effect<Record<string, StateResult>, RunnerError | SkillError | AgentError | GateError, RunnerDeps> =>
  Effect.gen(function* () {
    const skill = yield* loadSkill(skillPath)
    const skillDir = dirname(skillPath)
    const outputs: Record<string, StateResult> = {}
    const persistence = yield* Persistence

    const runId = yield* persistence.initRun(`skill:${skill.id} inputs:${JSON.stringify(inputs)}`)

    let currentState = skill.initial_state
    let steps = 0
    const MAX_STEPS = 50
    let totalInput = 0
    let totalOutput = 0
    let retryCount = 0

    while (steps++ < MAX_STEPS) {
      const stateDef = skill.states[currentState]
      if (!stateDef) {
        return yield* Effect.fail(new RunnerError(`Unknown state: ${currentState}`))
      }

      if (stateDef.terminal) break

      const statePrompt = interpolate(stateDef.agent_prompt, {
        inputs,
        outputs: Object.fromEntries(
          Object.entries(outputs).map(([k, v]) => [k, v.output])
        ),
      })

      const schemaInstructions = stateDef.output_schema
        ? `\n\nRespond with a JSON code block (\`\`\`json\n...\n\`\`\`) matching the required output schema.`
        : ""

      const fullPrompt = statePrompt + schemaInstructions

      yield* persistence.record(runId, {
        type: "llm_request",
        messages: [{ role: "user" as const, content: `[state: ${currentState}] ${fullPrompt}` }],
        ts: new Date().toISOString(),
      })

      type AgentOutcome =
        | { ok: true; text: string; usage: { input_tokens: number; output_tokens: number } }
        | { ok: false; action: "retry" | "skip"; error: RunnerError }

      // Inject project context snapshot into system prompt for this state
      const contextSnippet = yield* Effect.promise(() => buildContextPrompt())
      const stateSystem = contextSnippet
        ? `${systemContext ?? ""}\n\n${contextSnippet}`.trim()
        : systemContext

      if (verbose) {
        console.error(`[gates] state prompt: ${fullPrompt.slice(0, 200)}`)
      }

      const outcome = yield* runAgent(fullPrompt, stateSystem, runId, verbose).pipe(
        Effect.mapError((e): RunnerError => e instanceof RunnerError ? e : new RunnerError(`Agent failed in state ${currentState}`, e)),
        Effect.map((r): AgentOutcome => ({ ok: true, text: r.text, usage: r.usage })),
        Effect.catchTag("RunnerError", (e): Effect.Effect<AgentOutcome, RunnerError, Persistence> => {
          const policy = stateDef.on_error ?? "abort"
          const maxRetries = stateDef.max_retries ?? 2
          if (policy === "retry" && retryCount < maxRetries) {
            retryCount++
            return persistence.record(runId, { type: "state_error", state: currentState, policy, retryCount, error: e.reason, ts: new Date().toISOString() }).pipe(
              Effect.map((): AgentOutcome => ({ ok: false, action: "retry", error: e }))
            )
          }
          if (policy === "skip") {
            return persistence.record(runId, { type: "state_error", state: currentState, policy, retryCount, error: e.reason, ts: new Date().toISOString() }).pipe(
              Effect.map((): AgentOutcome => ({ ok: false, action: "skip", error: e }))
            )
          }
          return Effect.fail(e)
        })
      )

      if (!outcome.ok) {
        if (outcome.action === "retry") {
          console.error(`[gates] state ${currentState} failed, retrying (${retryCount})`)
          steps--
          continue
        }
        // skip
        retryCount = 0
        const stateNames = Object.keys(skill.states)
        const currentIdx = stateNames.indexOf(currentState)
        const nextLinear = stateNames[currentIdx + 1]
        const nextState = yield* resolveTransition(stateDef, {}, nextLinear)
        currentState = nextState
        continue
      }

      const { text: agentText, usage } = outcome
      retryCount = 0
      totalInput += usage.input_tokens
      totalOutput += usage.output_tokens

      let output: unknown = { result: agentText }
      if (stateDef.output_schema) {
        const parsed = extractJSON(agentText)
        if (parsed) output = parsed
      }

      outputs[currentState] = { state: currentState, output, agentText }

      console.error(`[gates] state: ${currentState} → `, JSON.stringify(output).slice(0, 120))

      const stateNames = Object.keys(skill.states)
      const currentIdx = stateNames.indexOf(currentState)
      const nextLinear = stateNames[currentIdx + 1]

      const nextState = yield* resolveTransition(stateDef, output, nextLinear)
      if (verbose) {
        console.error(`[gates] transition: ${currentState} → ${nextState}`)
      }
      currentState = nextState
    }

    if (steps >= MAX_STEPS) {
      return yield* Effect.fail(new RunnerError(`Skill exceeded ${MAX_STEPS} state transitions`))
    }

    const lastState = Object.keys(outputs).at(-1) ?? ""
    yield* persistence.record(runId, {
      type: "run_complete",
      result: lastState,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      ts: new Date().toISOString(),
    })
    console.error(`[gates] skill total: ${totalInput} in / ${totalOutput} out`)

    // Update project context for future runs (best-effort)
    yield* Effect.promise(() => updateContextFile())

    return outputs
  })

export class Runner extends Context.Service<Runner, {
  run: typeof runSkill
}>()("gates/Runner") {}

export const RunnerLayer = Layer.succeed(Runner)({ run: runSkill })
