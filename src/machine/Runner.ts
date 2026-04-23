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
import { writeRelevantPaths } from "../context/RelevantPaths.js"
import { buildResearchContext, formatResearchContext } from "../context/ResearchContext.js"
import { validate } from "./schema_validate.js"

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
  const fenced = /```json\s*([\s\S]+?)\s*```/.exec(text)
  if (fenced) {
    try { return JSON.parse(fenced[1]!) } catch { return null }
  }
  const raw = /(\{[\s\S]+\})/.exec(text)
  if (raw) {
    try { return JSON.parse(raw[1]!) } catch { return null }
  }
  return null
}

export type HITLCallback = (state: string, output: unknown, isError?: boolean) => Promise<boolean>

export const runSkill = (
  skillPath: string,
  inputs: Record<string, string> = {},
  systemContext?: string,
  verbose?: boolean,
  onHITL?: HITLCallback
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

      // For research state: pre-load metadata summaries + GitHub issues via Effect pipeline
      // This replaces LLM tool calls with deterministic data — zero tokens for discovery
      let researchInjection = ""
      if (currentState === "research") {
        const rawIssue = inputs["issue"] ?? ""
        const researchCtx = yield* buildResearchContext(rawIssue)
        researchInjection = formatResearchContext(researchCtx)
        console.error(`[gates] research context: ${researchCtx.summaries.length} summaries, ${researchCtx.related.length} related issues`)
      }

      // Inject project context — filter to files identified by analyze if available
      const analyzeFiles = (outputs["analyze"]?.output as Record<string, unknown>)?.files
      const filterFiles = Array.isArray(analyzeFiles) ? analyzeFiles as string[] : undefined
      const contextSnippet = yield* Effect.promise(() => buildContextPrompt(filterFiles))
      const stateSystem = [systemContext, contextSnippet, researchInjection]
        .filter(Boolean)
        .join("\n\n")
        .trim() || undefined

      if (verbose) {
        console.error(`[gates] state prompt: ${fullPrompt.slice(0, 200)}`)
      }

      type AgentOutcome =
        | { ok: true; text: string; usage: { input_tokens: number; output_tokens: number } }
        | { ok: false; action: "retry" | "skip"; error: RunnerError }

      // Measure llm_request duration
      const reqStart = performance.now()
      yield* persistence.record(runId, {
        type: "llm_request",
        messages: [{ role: "user" as const, content: `[state: ${currentState}] ${fullPrompt}` }],
        ts: new Date().toISOString(),
      })

      // Apply per-state timeout if configured
      const agentEffect = stateDef.timeout_ms
        ? Effect.promise(() =>
            Promise.race([
              Effect.runPromise(runAgent(fullPrompt, stateSystem, runId, verbose) as Effect.Effect<{ text: string; usage: { input_tokens: number; output_tokens: number } }, never, never>),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`State "${currentState}" timed out after ${stateDef.timeout_ms}ms`)), stateDef.timeout_ms!)
              ),
            ])
          ).pipe(Effect.mapError((e) => new RunnerError(`Timeout in state ${currentState}`, e)))
        : runAgent(fullPrompt, stateSystem, runId, verbose).pipe(
            Effect.mapError((e): RunnerError => e instanceof RunnerError ? e : new RunnerError(`Agent failed in state ${currentState}`, e))
          )

      const outcome = yield* agentEffect.pipe(
        Effect.map((r): AgentOutcome => ({ ok: true, text: r.text, usage: r.usage })),
        Effect.catchTag("RunnerError", (e): Effect.Effect<AgentOutcome, RunnerError, Persistence> => {
          const policy = stateDef.on_error ?? "abort"
          const maxRetries = stateDef.max_retries ?? 2

          // on_error_state: transition to a named state instead of crashing
          if (stateDef.on_error_state) {
            console.error(`[gates] ✗ ${e.reason} — transitioning to error state: ${stateDef.on_error_state}`)
            return persistence.record(runId, { type: "state_error", state: currentState, policy: "error_state", retryCount, error: e.reason, ts: new Date().toISOString() }).pipe(
              Effect.map((): AgentOutcome => ({ ok: false, action: "skip", error: e }))
            )
          }

          if (policy === "hitl" && onHITL) {
            return persistence.record(runId, { type: "state_error", state: currentState, policy: "hitl", retryCount, error: e.reason, ts: new Date().toISOString() }).pipe(
              Effect.andThen(() =>
                Effect.promise(() => onHITL(currentState, { error: e.reason, retryCount }, true))
              ),
              Effect.map((approved): AgentOutcome =>
                approved
                  ? { ok: false, action: "retry", error: e }   // true → retry
                  : { ok: false, action: "skip", error: e }    // false → skip to next state
              )
            )
          }

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
        retryCount = 0
        // on_error_state: jump to named state instead of linear next
        if (stateDef.on_error_state) {
          currentState = stateDef.on_error_state
          continue
        }
        // skip: advance linearly
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
        if (!parsed) {
          // Gate: output_schema declared but agent returned no valid JSON
          const policy = stateDef.on_error ?? "abort"
          const maxRetries = stateDef.max_retries ?? 2
          const msg = `Gate failed in state "${currentState}": output_schema declared but no JSON block found in response`
          console.error(`[gates] ✗ ${msg}`)
          yield* persistence.record(runId, { type: "state_error", state: currentState, policy, retryCount, error: msg, ts: new Date().toISOString() })
          if (policy === "retry" && retryCount < maxRetries) {
            retryCount++
            steps--
            continue
          }
          return yield* Effect.fail(new RunnerError(msg))
        }

        // Validate parsed output against schema
        const schema = yield* Effect.promise(() => loadOutputSchema(stateDef.output_schema!, skillDir))
        if (schema) {
          const err = validate(parsed, schema)
          if (err) {
            const policy = stateDef.on_error ?? "abort"
            const maxRetries = stateDef.max_retries ?? 2
            const msg = `Gate failed in state "${currentState}": schema validation error — ${err}`
            console.error(`[gates] ✗ ${msg}`)
            yield* persistence.record(runId, { type: "state_error", state: currentState, policy, retryCount, error: msg, ts: new Date().toISOString() })
            if (policy === "retry" && retryCount < maxRetries) {
              retryCount++
              steps--
              continue
            }
            return yield* Effect.fail(new RunnerError(msg))
          }
        }

        output = parsed
      }

      outputs[currentState] = { state: currentState, output, agentText }
      console.error(`[gates] ✓ state: ${currentState} → `, JSON.stringify(output).slice(0, 120))

      // After research: write files from research output
      if (currentState === "research") {
        const researchOut = output as Record<string, unknown>
        yield* Effect.promise(() => writeRelevantPaths({ files: researchOut["likely_files"] }))
      }

      // After analyze (PRP): overwrite relevant paths with confirmed contract files
      if (currentState === "analyze") {
        const prp = output as Record<string, unknown>
        const ctx = prp["context"] as Record<string, unknown> | undefined
        yield* Effect.promise(() => writeRelevantPaths({ files: ctx?.["files"] ?? [] }))
      }

      // HITL Gate — pause and require human approval before advancing
      if (stateDef.hitl_pause && onHITL) {
        const approved = yield* Effect.promise(() => onHITL(currentState, output))
        if (!approved) {
          return yield* Effect.fail(new RunnerError(`HITL: user rejected plan at state "${currentState}"`))
        }
      }

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
