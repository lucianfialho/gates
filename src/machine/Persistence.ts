import { Context, Effect, Layer } from "effect"
import { mkdir, appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Message } from "../services/LLM.js"
import type { ToolCall } from "../gates/Gate.js"
import type { ToolResult } from "../services/Tools.js"

// --- event types written to the JSONL run file ---

export type RunEvent =
  | { type: "run_start"; runId: string; prompt: string; ts: string; parentRunId?: string }
  | { type: "llm_request"; messages: Message[]; ts: string }
  | { type: "llm_response"; stop_reason: string | null; tool_calls: ToolCall[]; usage: { input_tokens: number; output_tokens: number }; ts: string }
  | { type: "gate_block"; gate: string; reason: string; call: ToolCall; ts: string }
  | { type: "tool_result"; results: ToolResult[]; ts: string }
  | { type: "run_complete"; result: string; total_input_tokens: number; total_output_tokens: number; ts: string }
  | { type: "run_failed"; error: string; ts: string }
  | { type: "state_error"; state: string; policy: string; retryCount: number; error: string; ts: string }

export interface PersistenceShape {
  readonly initRun: (prompt: string, parentRunId?: string) => Effect.Effect<string>
  readonly record: (runId: string, event: RunEvent) => Effect.Effect<void>
}

export class Persistence extends Context.Service<Persistence, PersistenceShape>()(
  "gates/Persistence"
) {}

const runsDir = join(process.cwd(), ".gates", "runs")

const makeImpl: Effect.Effect<PersistenceShape> = Effect.sync(() => {
  const initRun = (prompt: string, parentRunId?: string): Effect.Effect<string> =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(runsDir, { recursive: true })
        const runId = crypto.randomUUID()
        const event: RunEvent = {
          type: "run_start",
          runId,
          prompt,
          ts: new Date().toISOString(),
          ...(parentRunId ? { parentRunId } : {}),
        }
        await writeFile(join(runsDir, `${runId}.jsonl`), JSON.stringify(event) + "\n")
        return runId
      },
      catch: (e) => new Error(String(e)),
    }).pipe(Effect.orDie)

  const record = (runId: string, event: RunEvent): Effect.Effect<void> =>
    Effect.tryPromise({
      try: () =>
        appendFile(
          join(runsDir, `${runId}.jsonl`),
          JSON.stringify(event) + "\n"
        ),
      catch: (e) => new Error(String(e)),
    }).pipe(Effect.orDie)

  return { initRun, record }
})

export const PersistenceLayer = Layer.effect(Persistence)(makeImpl)
