import { Effect, Ref } from "effect"
import { LLMService, type Message } from "../services/LLM.js"
import { GateRegistry } from "../services/GateRegistry.js"
import { ToolRegistry, type ToolResult, ToolError } from "../services/Tools.js"
import { GateError, type ToolCall } from "../gates/Gate.js"

export class AgentError {
  readonly _tag = "AgentError"
  constructor(readonly cause: unknown) {}
}

type RunDeps = LLMService | GateRegistry | ToolRegistry

const executeToolCalls = (
  calls: ToolCall[]
): Effect.Effect<ToolResult[], AgentError | GateError, RunDeps> =>
  Effect.gen(function* () {
    const gates = yield* GateRegistry
    const tools = yield* ToolRegistry

    return yield* Effect.forEach(
      calls,
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
  })

export const run = (
  prompt: string
): Effect.Effect<string, AgentError | GateError, RunDeps> =>
  Effect.gen(function* () {
    const llm = yield* LLMService
    const tools = yield* ToolRegistry

    const messagesRef = yield* Ref.make<Message[]>([
      { role: "user" as const, content: prompt },
    ])
    const resultRef = yield* Ref.make<string | null>(null)

    let done = false

    yield* Effect.whileLoop({
      while: () => !done,
      body: () =>
        Effect.gen(function* () {
          const messages = yield* Ref.get(messagesRef)
          const response = yield* llm
            .complete(messages, tools.definitions)
            .pipe(Effect.mapError((e) => new AgentError(e.cause)))

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
            yield* Ref.set(resultRef, last?.type === "text" ? last.text : "")
            done = true
            return
          }

          const results = yield* executeToolCalls(response.tool_calls)
          const withTools: Message[] = [
            ...withAssistant,
            { role: "tool" as const, results },
          ]
          yield* Ref.set(messagesRef, withTools)
        }),
      step: () => {},
    })

    return (yield* Ref.get(resultRef)) ?? ""
  })
