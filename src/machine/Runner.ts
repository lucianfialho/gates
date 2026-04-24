import { Effect, Context, Layer } from "effect"
import { readFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { loadSkill, interpolate, resolveTransition, type Skill, SkillError } from "./Skill.js"
import { Persistence } from "./Persistence.js"
import { run as runAgent, type RunResult, type ChatEvent } from "../agent/Loop.js"
import { LLMService } from "../services/LLM.js"
import { GateRegistry } from "../services/GateRegistry.js"
import { ToolRegistry } from "../services/Tools.js"
import { AgentError } from "../agent/Loop.js"
import { GateError } from "../gates/Gate.js"
import { buildContextPrompt, updateContextFile } from "../context/ProjectContext.js"
import { writeRelevantPaths } from "../context/RelevantPaths.js"
import { buildResearchContext, formatResearchContext } from "../context/ResearchContext.js"
import { clearReadHistory } from "../gates/ReadDedup.js"
import { buildResearchManifest, formatManifestContext, clearManifest } from "../context/ResearchManifest.js"
import { validate } from "./schema_validate.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// Deterministic branch creation — no LLM needed
const runBranch = async (prp: Record<string, unknown>): Promise<string> => {
  const issueNum = prp["issue_number"]
  const prpId = prp["id"] as string | undefined
  const branch = issueNum ? `issue-${issueNum}` : (prpId ?? "feature").slice(0, 40)
  try {
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: process.cwd() })
  } catch {
    // branch may already exist — checkout and continue
    await execFileAsync("git", ["checkout", branch], { cwd: process.cwd() })
  }
  console.error(`[gates] ✓ branch: ${branch}`)
  return branch
}

// Deterministic commit + push + PR — no LLM needed
const runOpenPR = async (
  prp: Record<string, unknown>,
  branch: string,
  implementSummary: string
): Promise<string> => {
  const issueNum = prp["issue_number"]
  const title = (prp["issue_title"] as string | undefined) ?? implementSummary
  const id = prp["id"] as string | undefined ?? "fix"

  // Detect conventional commit type from PRP id or title
  const type = id.startsWith("fix") || title.toLowerCase().startsWith("fix") ? "fix" :
               id.startsWith("feat") || id.startsWith("add") ? "feat" :
               id.startsWith("doc") ? "docs" :
               id.startsWith("refactor") ? "refactor" : "feat"

  const footer = [
    `Co-Authored-By: Gates <noreply@gates.dev>`,
    issueNum ? `Closes #${issueNum}` : "",
  ].filter(Boolean).join("\n")

  const commitMsg = `${type}: ${title}\n\n${footer}`

  await execFileAsync("git", ["add", "-A"], { cwd: process.cwd() })
  await execFileAsync("git", ["commit", "-m", commitMsg], { cwd: process.cwd() })
  await execFileAsync("git", ["push", "--set-upstream", "origin", branch], { cwd: process.cwd() })

  const body = [
    `## Summary\n${implementSummary}`,
    issueNum ? `Closes #${issueNum}` : "",
    `\n🤖 Generated with [gates](https://github.com/lucianfialho/gates)`,
  ].filter(Boolean).join("\n\n")

  const { stdout } = await execFileAsync(
    "gh", ["pr", "create", "--title", title, "--body", body, "--base", "main"],
    { cwd: process.cwd() }
  )
  const prUrl = stdout.trim()
  console.error(`[gates] ✓ PR: ${prUrl}`)
  return prUrl
}

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
  onHITL?: HITLCallback,
  onEvent?: (event: ChatEvent) => void,
  resumeOutputs?: Record<string, StateResult>
): Effect.Effect<Record<string, StateResult>, RunnerError | SkillError | AgentError | GateError, RunnerDeps> =>
  Effect.gen(function* () {
    const skill = yield* loadSkill(skillPath)
    const skillDir = dirname(skillPath)
    const outputs: Record<string, StateResult> = resumeOutputs ? { ...resumeOutputs } : {}
    const persistence = yield* Persistence

    const runId = yield* persistence.initRun(`skill:${skill.id} inputs:${JSON.stringify(inputs)}`)

    // ── Deterministic pre-processing (zero LLM tokens) ──────────────────────
    const issue         = inputs["issue"]                ?? ""
    const chatCtx       = inputs["chat_context"]         ?? ""
    const stateOverride = inputs["initial_state_override"] ?? ""

    // Hard override — Gateway can force entry at any state (e.g. PATCH → analyze)
    if (stateOverride && skill.states[stateOverride]) {
      console.error(`[gates] ✓ initial_state_override: ${stateOverride}`)
      // Pre-fill outputs for all skipped states so interpolation doesn't break
      for (const stateName of Object.keys(skill.states)) {
        if (stateName === stateOverride) break
        const s = skill.states[stateName]
        if (!s?.terminal) outputs[stateName] = { state: stateName, output: {}, agentText: "skipped-by-override" }
      }
    } else {
      // Extract file paths from chat context (regex, no LLM)
      const filePattern = /(?:^|[\s"'`(])((?:src|skills|tests?)\/[\w/.-]+\.(?:ts|tsx|yaml|json|md))/gm
      const filesInChat = [...new Set(
        [...chatCtx.matchAll(filePattern)].map(m => (m[1] ?? "").trim())
      )].filter(Boolean)

      const isIssueNum = /^\d+$/.test(issue.trim())

      // Skip clarify if: issue number OR chat already mentions specific files/context
      if (isIssueNum || filesInChat.length > 0 || chatCtx.length > 100) {
        outputs["clarify"] = { state: "clarify", output: { ready: true, questions: [] }, agentText: "deterministic" }
        console.error(`[gates] ✓ clarify: skipped (deterministic) — isNum=${isIssueNum} files=${filesInChat.length} ctxLen=${chatCtx.length}`)
      }

      // Skip research if chat already has file paths
      if (filesInChat.length > 0) {
        const relevantDirs = [...new Set(filesInChat.map(f => f.split("/").slice(0, 2).join("/")))]
        outputs["research"] = {
          state: "research",
          output: {
            relevant_dirs: relevantDirs,
            likely_files: filesInChat,
            research_summary: `Files extracted from conversation: ${filesInChat.join(", ")}`,
            out_of_scope: [],
          },
          agentText: "deterministic",
        }
        console.error(`[gates] ✓ research: skipped (deterministic) — files: ${filesInChat.join(", ")}`)
        yield* Effect.promise(() => writeRelevantPaths({ files: filesInChat }))
      }
    }

    // Start from the right state based on what was pre-computed
    let currentState = stateOverride && skill.states[stateOverride]
                       ? stateOverride
                       : outputs["research"]  ? "analyze"
                       : outputs["clarify"]   ? "research"
                       : skill.initial_state
    // ─────────────────────────────────────────────────────────────────────────

    let steps = 0
    const MAX_STEPS = 50
    let totalInput = 0
    let totalOutput = 0
    let retryCount = 0
    let stateTokensTotal = 0   // cumulative tokens for the current state
    let roundsWithoutWrite = 0  // consecutive rounds with no write/edit/mode_switch
    const STUCK_THRESHOLD = 8   // rounds before suggesting mode_switch

    const nonTerminalStates = Object.entries(skill.states)
      .filter(([, s]) => !s.terminal).length

    while (steps++ < MAX_STEPS) {
      const stateDef = skill.states[currentState]
      if (!stateDef) {
        return yield* Effect.fail(new RunnerError(`Unknown state: ${currentState}`))
      }

      if (stateDef.terminal) break

      // Reset read-dedup history, token counter, and stuck counter on state change
      clearReadHistory()
      stateTokensTotal = 0
      roundsWithoutWrite = 0

      // Expose current state to gates (e.g. VerifyReadOnly blocks writes in verify)
      process.env["GATES_ACTIVE_STATE"] = currentState

      // Emit state change so TUI can show current phase
      const stateStep = Object.keys(skill.states).indexOf(currentState) + 1
      onEvent?.({ type: "state_change", state: currentState, step: stateStep, total: nonTerminalStates })

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

      // For research state: build deterministic manifest (zero LLM tokens) + metadata summaries
      // Manifest = autoresearch pattern: pre-scope files before agent reads anything
      let researchInjection = ""
      if (currentState === "research") {
        const rawIssue = inputs["issue"] ?? ""

        // Step 1: Build manifest deterministically (zero LLM) — autoresearch pattern
        const manifest = yield* Effect.promise(() => buildResearchManifest(rawIssue))
        const manifestText = formatManifestContext(manifest)
        console.error(`[gates] manifest: ${manifest.manifest.length} files pre-scoped (0 LLM tokens)`)

        // Step 2: Load metadata summaries + GitHub issues
        const researchCtx = yield* buildResearchContext(rawIssue)
        researchInjection = manifestText + "\n" + formatResearchContext(researchCtx)
        console.error(`[gates] research context: ${researchCtx.summaries.length} summaries, ${researchCtx.related.length} related issues`)
      }

      // Clear manifest when leaving research state
      if (currentState !== "research" && outputs["research"]) {
        yield* Effect.promise(() => clearManifest().catch(() => {}))
      }

      // Inject project context — filter to confirmed files only (reduces tokens significantly)
      const prpOutput = outputs["analyze"]?.output as Record<string, unknown> | undefined
      // PRP schema: context.files. Legacy schema: files directly.
      const prpFiles = (prpOutput?.["context"] as Record<string, unknown>)?.["files"]
      const legacyFiles = prpOutput?.["files"]
      // Before analyze: use research output's likely_files as filter
      const researchFiles = (outputs["research"]?.output as Record<string, unknown>)?.["likely_files"]
      const rawFiles = prpFiles ?? legacyFiles ?? researchFiles
      const filterFiles = Array.isArray(rawFiles) ? rawFiles as string[] : undefined
      const contextSnippet = yield* Effect.promise(() => buildContextPrompt(filterFiles))
      // Stuck hint — injected when agent hasn't written anything in STUCK_THRESHOLD rounds
      const stuckHint = roundsWithoutWrite >= STUCK_THRESHOLD
        ? `\n\n⚠ STUCK NOTICE: You've been reading/analyzing for ${roundsWithoutWrite} rounds without any writes or edits.\nIf the current approach isn't working, call mode_switch(mode, reason) to signal a mode change.\nAvailable: PATCH (targeted edit), STANDARD (full lifecycle), REFACTOR (decompose large files), ProRN (read-only explanation).`
        : ""

      // React to mode_switch calls from previous round
      const activeMode = process.env["GATES_ACTIVE_MODE"]
      const MODE_HINTS: Record<string, string> = {
        PATCH: "\nMode: PATCH — make the smallest targeted edit possible. Use edit() not write(). No new files.",
        STANDARD: "\nMode: STANDARD — full lifecycle, proceed normally.",
        REFACTOR: "\nMode: REFACTOR — decompose large files into modules < 150 lines. Use write() for new files.",
        ProRN: "\nMode: READ-ONLY — explain only, do NOT edit, write, or commit any files.",
        LEARN: "\nMode: LEARN — write documentation or explanations only.",
      }
      const modeHint = activeMode && MODE_HINTS[activeMode] ? MODE_HINTS[activeMode] : ""

      // Enforce execute_code via system prompt — Devin-pattern: hard prohibition + reason
      // "Never use grep or find to search. Use your built-in search commands." (Devin, repeated 2x)
      const executeCodeRule = `\nTOOL RULES (mandatory):\n• You must NEVER call grep() or read_lines() as individual tool calls. They add O(N) round-trips to history.\n• You must ALWAYS bundle file inspection into execute_code():\n  execute_code(\`const src = await readLines("path", 1, 80); const hits = await grep("pattern", "dir"); console.log({src, hits})\`)\n• When inspecting multiple files or running multiple searches, bundle ALL of them into ONE execute_code call.\n• read() on small files (<120 lines) is allowed. write(), edit(), bash(), glob() are always allowed.`

      const stateSystem = [systemContext, contextSnippet, researchInjection, executeCodeRule, modeHint + stuckHint]
        .filter(Boolean)
        .join("\n\n")
        .trim() || undefined

      if (verbose) {
        console.error(`[gates] state prompt: ${fullPrompt.slice(0, 200)}`)
        if (stuckHint) console.error(`[gates] stuck hint injected (rounds=${roundsWithoutWrite})`)
        if (modeHint) console.error(`[gates] mode hint injected: ${activeMode}`)
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

      // Track write/edit/mode_switch calls to detect stuck agent
      let wroteThisRound = false
      const trackingOnEvent = (ev: ChatEvent) => {
        if (ev.type === "tool_call") {
          const name = (ev as { type: "tool_call"; name: string }).name
          if (name === "write" || name === "edit" || name === "mode_switch") {
            wroteThisRound = true
          }
        }
        onEvent?.(ev)
      }

      // Apply per-state timeout if configured
      const agentEffect = stateDef.timeout_ms
        ? Effect.promise(() =>
            Promise.race([
              Effect.runPromise(runAgent(fullPrompt, stateSystem, runId, verbose, trackingOnEvent, stateDef.budget_tokens) as Effect.Effect<{ text: string; usage: { input_tokens: number; output_tokens: number } }, never, never>),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`State "${currentState}" timed out after ${stateDef.timeout_ms}ms`)), stateDef.timeout_ms!)
              ),
            ])
          ).pipe(Effect.mapError((e) => new RunnerError(`Timeout in state ${currentState}`, e)))
        : runAgent(fullPrompt, stateSystem, runId, verbose, trackingOnEvent, stateDef.budget_tokens).pipe(
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
      stateTokensTotal += usage.input_tokens + usage.output_tokens

      // Update stuck counter based on whether agent wrote anything
      if (wroteThisRound) {
        roundsWithoutWrite = 0
        console.error(`[gates] ✓ write detected — stuck counter reset`)
      } else {
        roundsWithoutWrite++
        if (roundsWithoutWrite >= STUCK_THRESHOLD) {
          console.error(`[gates] ⚠ stuck: ${roundsWithoutWrite} rounds without writes — mode_switch hint injected`)
        }
      }

      // Budget gate — enforce cumulative token limit for this state
      if (stateDef.budget_tokens) {
        const pct = Math.round((stateTokensTotal / stateDef.budget_tokens) * 100)
        if (stateTokensTotal > stateDef.budget_tokens) {
          const msg = `Budget exceeded in "${currentState}": ${stateTokensTotal.toLocaleString()} tokens used (cumulative), budget was ${stateDef.budget_tokens.toLocaleString()}`
          console.error(`[gates] ⚠ ${msg}`)
          onEvent?.({ type: "gate_block", gate: "budget", reason: msg })
          const policy = stateDef.on_error ?? "abort"
          if (policy === "hitl" && onHITL) {
            const approved = yield* Effect.promise(() => onHITL(currentState, { budget_exceeded: stateTokensTotal, budget: stateDef.budget_tokens }, true))
            if (!approved) return yield* Effect.fail(new RunnerError(msg))
          } else if (policy !== "skip") {
            return yield* Effect.fail(new RunnerError(msg))
          }
        } else if (pct >= 80) {
          console.error(`[gates] ⚠ budget warning: "${currentState}" at ${pct}% (${stateTokensTotal.toLocaleString()}/${stateDef.budget_tokens.toLocaleString()})`)
          onEvent?.({ type: "gate_block", gate: "budget-warning", reason: `${currentState} at ${pct}% of token budget` })
        }
      }

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
          if (policy === "hitl" && onHITL) {
            const approved = yield* Effect.promise(() => onHITL(currentState, { error: msg, retryCount }, true))
            if (approved) { retryCount++; steps--; continue }
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
            if (policy === "hitl" && onHITL) {
              const approved = yield* Effect.promise(() => onHITL(currentState, { error: msg, retryCount }, true))
              if (approved) { retryCount++; steps--; continue }
            }
            return yield* Effect.fail(new RunnerError(msg))
          }
        }

        output = parsed
      }

      outputs[currentState] = { state: currentState, output, agentText }
      yield* persistence.record(runId, { type: "state_complete", state: currentState, output, agentText: agentText.slice(0, 200), ts: new Date().toISOString() })
      console.error(`[gates] ✓ state: ${currentState} → `, JSON.stringify(output).slice(0, 120))

      // After research: write files from research output
      if (currentState === "research") {
        const researchOut = output as Record<string, unknown>
        yield* Effect.promise(() => writeRelevantPaths({ files: researchOut["likely_files"] }))
      }

      // After analyze (PRP): overwrite relevant paths + create branch deterministically
      if (currentState === "analyze") {
        const prp = output as Record<string, unknown>
        const ctx = prp["context"] as Record<string, unknown> | undefined
        yield* Effect.promise(() => writeRelevantPaths({ files: ctx?.["files"] ?? [] }))
      }

      // After verify: create branch + commit + push + PR deterministically (no LLM)
      if (currentState === "verify") {
        const verifyOut = output as Record<string, unknown>
        const passed = verifyOut["passed"]
        if (passed) {
          const prp = (outputs["analyze"]?.output ?? {}) as Record<string, unknown>
          const implOut = (outputs["implement"]?.output ?? {}) as Record<string, unknown>
          const summary = String(implOut["summary"] ?? "implement changes")
          // Create branch from PRP data
          const branch = yield* Effect.promise(() => runBranch(prp))
          // Commit + push + create PR
          const prUrl = yield* Effect.promise(() => runOpenPR(prp, branch, summary))
          // Inject PR URL into outputs so the skill can show it
          outputs["_pr"] = { state: "_pr", output: { pr_url: prUrl, branch }, agentText: "" }
          console.error(`[gates] ✓ open_pr: ${prUrl}`)
        }
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

    // Record cache metrics if available
    const llm = yield* LLMService
    if (llm.getCacheMetrics) {
      const metrics = yield* llm.getCacheMetrics()
      yield* persistence.record(runId, {
        type: "cache_metrics",
        metrics: {
          cache_hits: metrics.cacheHits,
          cache_invalidations: metrics.cacheInvalidations,
          tokens_cached: metrics.tokensCached,
        },
        ts: new Date().toISOString(),
      })
    }

    console.error(`[gates] skill total: ${totalInput} in / ${totalOutput} out`)

    // Update project context for future runs (best-effort)
    yield* Effect.promise(() => updateContextFile())

    return outputs
  })

export class Runner extends Context.Service<Runner, {
  run: typeof runSkill
}>()("gates/Runner") {}

export const RunnerLayer = Layer.succeed(Runner)({ run: runSkill })
