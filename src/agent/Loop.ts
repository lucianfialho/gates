import { Effect, Ref } from "effect"
import { LLMService, type Message } from "../services/LLM.js"
import { GateRegistry } from "../services/GateRegistry.js"
import { ToolRegistry, type ToolResult, ToolError } from "../services/Tools.js"
import { GateError, type ToolCall } from "../gates/Gate.js"
import { Persistence } from "../machine/Persistence.js"

export class AgentError {
  readonly _tag = "AgentError"
  constructor(readonly cause: unknown) {}
}

type RunDeps = LLMService | GateRegistry | ToolRegistry | Persistence

const now = () => new Date().toISOString()

const executeToolCalls = (
  runId: string,
  calls: ToolCall[]
): Effect.Effect<ToolResult[], AgentError | GateError, RunDeps> =>
  Effect.gen(function* () {
    const gates = yield* GateRegistry
    const tools = yield* ToolRegistry
    const persistence = yield* Persistence

    return yield* Effect.forEach(
      calls,
      (call: ToolCall) =>
        gates.enforce(call).pipe(
          Effect.catchTag("GateError", (e) =>
            persistence
              .record(runId, {
                type: "gate_block",
                gate: e.gate,
                reason: e.reason,
                call,
                ts: now(),
              })
              .pipe(Effect.andThen(Effect.fail(e)))
          ),
          Effect.andThen(
            tools.execute(call.id, call.name, call.input).pipe(
              Effect.mapError((e: ToolError) => new AgentError(e.cause))
            )
          )
        ),
      { concurrency: 1 }
    )
  })

export interface RunResult {
  text: string
  usage: { input_tokens: number; output_tokens: number }
}

export const run = (
  prompt: string,
  systemPrompt?: string
): Effect.Effect<RunResult, AgentError | GateError, RunDeps> =>
  Effect.gen(function* () {
    const llm = yield* LLMService
    const tools = yield* ToolRegistry
    const persistence = yield* Persistence

    const runId = yield* persistence.initRun(prompt)

    const messagesRef = yield* Ref.make<Message[]>([
      { role: "user" as const, content: prompt },
    ])
    const resultRef = yield* Ref.make<string | null>(null)
    const usageRef = yield* Ref.make({ input_tokens: 0, output_tokens: 0 })

    let done = false

    yield* Effect.whileLoop({
      while: () => !done,
      body: () =>
        Effect.gen(function* () {
          const messages = yield* Ref.get(messagesRef)

          yield* persistence.record(runId, {
            type: "llm_request",
            messages,
            ts: now(),
          })

          const response = yield* llm
            .complete(messages, tools.definitions, systemPrompt)
            .pipe(Effect.mapError((e) => new AgentError(e.cause)))

          yield* Ref.update(usageRef, (u) => ({
            input_tokens: u.input_tokens + response.usage.input_tokens,
            output_tokens: u.output_tokens + response.usage.output_tokens,
          }))

          yield* persistence.record(runId, {
            type: "llm_response",
            stop_reason: response.stop_reason,
            tool_calls: response.tool_calls,
            usage: response.usage,
            ts: now(),
          })

          const withAssistant: Message[] = [
            ...messages,
            { role: "assistant" as const, content: response.content },
          ]
          yield* Ref.set(messagesRef, withAssistant)

          if (
            response.stop_reason === "end_turn" ||
            response.tool_calls.length === 0
          ) {
            const last = response.content.find((b) => b.type === "text")
            const result = last?.type === "text" ? last.text : ""
            yield* Ref.set(resultRef, result)
            const totalUsage = yield* Ref.get(usageRef)
            yield* persistence.record(runId, {
              type: "run_complete",
              result,
              total_input_tokens: totalUsage.input_tokens,
              total_output_tokens: totalUsage.output_tokens,
              ts: now(),
            })
            console.error(
              `[gates] tokens: ${totalUsage.input_tokens} in / ${totalUsage.output_tokens} out`
            )
            done = true
            return
          }

          const results = yield* executeToolCalls(runId, response.tool_calls)

          yield* persistence.record(runId, {
            type: "tool_result",
            results,
            ts: now(),
          })

          const withTools: Message[] = [
            ...withAssistant,
            { role: "tool" as const, results },
          ]
          yield* Ref.set(messagesRef, withTools)
        }),
      step: () => {},
    })

    const totalUsage = yield* Ref.get(usageRef)
    return { text: (yield* Ref.get(resultRef)) ?? "", usage: totalUsage }
  })
