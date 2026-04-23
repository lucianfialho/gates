import { Effect } from "effect"
import Anthropic from "@anthropic-ai/sdk"
import type { LLMShape, LLMError, Message, ToolDef, LLMResponse } from "../LLM.js"

const MODEL = process.env.GATES_MODEL ?? "claude-sonnet-4-6"

export const makeAnthropicProvider = (apiKey: string): LLMShape => {
  const client = new Anthropic({ apiKey })

  const complete = (
    messages: Message[],
    tools: ToolDef[],
    system?: string
  ): Effect.Effect<LLMResponse, LLMError> =>
    Effect.tryPromise({
      try: () =>
        client.messages.create({
          model: MODEL,
          max_tokens: 8096,
          ...(system ? { system } : {}),
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
          messages: messages.map((m) => {
            if (m.role === "tool") {
              return {
                role: "user" as const,
                content: m.results.map((r) => ({
                  type: "tool_result" as const,
                  tool_use_id: r.id,
                  content: r.content,
                })),
              }
            }
            return m
          }),
        }),
      catch: (e): LLMError => ({ _tag: "LLMError" as const, cause: e }),
    }).pipe(
      Effect.map((res) => ({
        stop_reason: res.stop_reason,
        content: res.content,
        usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
        tool_calls: res.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input })),
      }))
    )

  return { complete }
}
