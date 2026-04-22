import { Effect } from "effect"
import { LLMService, type Message } from "../services/LLM.js"
import { GateRegistry } from "../services/GateRegistry.js"
import { ToolRegistry, ToolError } from "../services/Tools.js"
import { GateError, type ToolCall } from "../gates/Gate.js"

export class AgentError {
  readonly _tag = "AgentError"
  constructor(readonly cause: unknown) {}
}

type RunDeps = LLMService | GateRegistry | ToolRegistry

const step = (
  messages: Message[]
): Effect.Effect<string, AgentError | GateError, RunDeps> =>
  Effect.gen(function* () {
    const llm = yield* LLMService
    const gates = yield* GateRegistry
    const tools = yield* ToolRegistry

    const response = yield* llm.complete(messages, tools.definitions).pipe(
      Effect.mapError((e) => new AgentError(e.cause))
    )

    const updated: Message[] = [
      ...messages,
      { role: "assistant", content: response.content },
    ]

    if (response.stop_reason === "end_turn" || response.tool_calls.length === 0) {
      const last = response.content.find((b) => b.type === "text")
      return last?.type === "text" ? last.text : ""
    }

    const results = yield* Effect.forEach(
      response.tool_calls,
      (call: ToolCall) =>
        gates.enforce(call).pipe(
          Effect.andThen(
            tools.execute(call.id, call.name, call.input).pipe(
              Effect.mapError((e: ToolError) => new AgentError(e.cause))
            )
          )
        ),
      { concurrency: 1 }
    )

    return yield* step([...updated, { role: "tool", results }])
  })

export const run = (
  prompt: string
): Effect.Effect<string, AgentError | GateError, RunDeps> =>
  step([{ role: "user", content: prompt }])
