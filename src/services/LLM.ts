import { Context, Effect, Layer } from "effect"
import Anthropic from "@anthropic-ai/sdk"
import type { ToolCall } from "../gates/Gate.js"
import { Auth } from "../auth/Auth.js"

export class LLMError {
  readonly _tag = "LLMError"
  constructor(readonly cause: unknown) {}
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: Anthropic.ContentBlock[] }
  | { role: "tool"; results: Array<{ id: string; content: string }> }

export interface ToolDef {
  name: string
  description: string
  input_schema: Anthropic.Tool["input_schema"]
}

export interface LLMResponse {
  stop_reason: Anthropic.Message["stop_reason"]
  content: Anthropic.ContentBlock[]
  tool_calls: ToolCall[]
  usage: { input_tokens: number; output_tokens: number }
}

export interface LLMShape {
  readonly complete: (
    messages: Message[],
    tools: ToolDef[],
    system?: string
  ) => Effect.Effect<LLMResponse, LLMError>
}

export class LLMService extends Context.Service<LLMService, LLMShape>()(
  "gates/LLMService"
) {}

const makeImpl: Effect.Effect<LLMShape, never, Auth> = Effect.gen(function* () {
  const auth = yield* Auth
  const apiKey = yield* auth.getApiKey()
  if (!apiKey) {
    console.error(
      "\nNo API key found. Run: gates auth set sk-ant-...\n" +
      "Or set ANTHROPIC_API_KEY env var.\n" +
      "Get a key at https://console.anthropic.com/settings/keys\n"
    )
    process.exit(1)
  }
  const client = new Anthropic({ apiKey })

  const complete = (
    messages: Message[],
    tools: ToolDef[],
    system?: string
  ): Effect.Effect<LLMResponse, LLMError> =>
    Effect.tryPromise({
      try: () =>
        client.messages.create({
          model: "claude-sonnet-4-6",
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
      catch: (e) => new LLMError(e),
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
})

export const LLMLayer = Layer.effect(LLMService)(makeImpl).pipe(
  Layer.provide(AuthLayer)
)

import { AuthLayer } from "../auth/Auth.js"
