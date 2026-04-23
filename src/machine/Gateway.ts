import { Context, Effect, Layer, pipe } from "effect"
import type Anthropic from "@anthropic-ai/sdk"
import { LLMService, LLMError } from "../services/LLM.js"

export type GatewayMode = "ProRN" | "LEARN" | "PATCH" | "STANDARD"

export interface GatewayDecision {
  mode: GatewayMode
  intent: string
  shortcutUsed?: string
}

export class GatewayError {
  readonly _tag = "GatewayError" as const
  constructor(readonly reason: string) {}
}

export interface GatewayShape {
  readonly classify: (
    prompt: string
  ) => Effect.Effect<GatewayDecision, GatewayError | LLMError>
}

export class GatewayService extends Context.Service<GatewayService, GatewayShape>()(
  "gates/GatewayService"
) {}

// ── Shortcut detection — zero LLM cost ──────────────────────────────────────

const SHORTCUT_MAP: Record<string, GatewayMode> = {
  "@read":     "ProRN",
  "@patch":    "PATCH",
  "@standard": "STANDARD",
  "@learn":    "LEARN",
}

const detectShortcut = (
  prompt: string
): { shortcut: string; mode: GatewayMode; rest: string } | null => {
  const match = /^(@\w+)\s+/i.exec(prompt.trim())
  if (!match) return null
  const sc = match[1]!.toLowerCase()
  const mode = SHORTCUT_MAP[sc]
  if (!mode) return null
  return { shortcut: sc, mode, rest: prompt.slice(match[0].length).trim() }
}

// ── Heuristic classifier — zero LLM cost ────────────────────────────────────

const heuristicMode = (intent: string): GatewayMode | null => {
  const lower = intent.toLowerCase()

  if (/^(what|why|how|explain|show me|list|where|who|can you tell|describe)\b/i.test(lower)) return "ProRN"
  if (/\?$/.test(intent.trim()) && intent.length < 120) return "ProRN"

  if (/^(fix typo|rename|update the|change the)\b/i.test(lower)) return "PATCH"
  if (/\b(document|add docs|write docs|add jsdoc|add comments)\b/i.test(lower)) return "LEARN"

  return null
}

// ── LLM classifier — fallback when heuristic returns null ───────────────────

const LLM_CLASSIFY_PROMPT = `Classify the following coding task into exactly one mode.

Modes:
- ProRN   : read-only Q&A, no file changes
- LEARN   : write docs, comments, or explanations only
- PATCH   : tiny targeted change (rename, typo, single-line fix)
- STANDARD: implement a feature, fix a bug, refactor, or any multi-step change

Reply with a JSON block only:
\`\`\`json
{"mode": "STANDARD"}
\`\`\``

const classifyWithLLM = (
  intent: string
): Effect.Effect<GatewayMode, GatewayError | LLMError, LLMService> =>
  Effect.gen(function* () {
    const llm = yield* LLMService
    const res = yield* llm.complete(
      [{ role: "user", content: `Task: ${intent}\n\n${LLM_CLASSIFY_PROMPT}` }],
      [],
      undefined
    )

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")

    const match = /\{\s*"mode"\s*:\s*"(\w+)"\s*\}/.exec(text)
    if (!match) return yield* Effect.fail(new GatewayError(`LLM returned unparseable classification: ${text.slice(0, 100)}`))

    const raw = match[1]!
    if (raw !== "ProRN" && raw !== "LEARN" && raw !== "PATCH" && raw !== "STANDARD") {
      return yield* Effect.fail(new GatewayError(`Unknown mode from LLM: ${raw}`))
    }
    return raw as GatewayMode
  })

// ── Live implementation ──────────────────────────────────────────────────────

const makeImpl = Effect.gen(function* () {
  const llm = yield* LLMService

  const classify = (prompt: string): Effect.Effect<GatewayDecision, GatewayError | LLMError> => {
    // 1. Shortcut wins — zero tokens
    const sc = detectShortcut(prompt)
    if (sc) {
      console.error(`[gateway] shortcut ${sc.shortcut} → ${sc.mode}`)
      return Effect.succeed({ mode: sc.mode, intent: sc.rest, shortcutUsed: sc.shortcut })
    }

    const intent = prompt.trim()

    // 2. Heuristic — zero tokens
    const heuristic = heuristicMode(intent)
    if (heuristic) {
      console.error(`[gateway] heuristic → ${heuristic}`)
      return Effect.succeed({ mode: heuristic, intent })
    }

    // 3. LLM with timeout — fallback to STANDARD so the user is never blocked
    // llm is captured from makeImpl's Effect.gen scope
    console.error(`[gateway] LLM classify...`)
    return pipe(
      classifyWithLLM(intent).pipe(Effect.provideService(LLMService, llm)),
      Effect.timeout("3 seconds"),
      Effect.map((mode) => {
        console.error(`[gateway] LLM → ${mode}`)
        return { mode: mode ?? "STANDARD", intent } satisfies GatewayDecision
      }),
      Effect.orElseSucceed(() => {
        console.error(`[gateway] timeout/error — fallback STANDARD`)
        return { mode: "STANDARD" as const, intent }
      })
    )
  }

  return { classify }
})

export const GatewayServiceLive: Layer.Layer<GatewayService, never, LLMService> =
  Layer.effect(GatewayService, makeImpl)
