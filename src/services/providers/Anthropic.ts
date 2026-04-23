import { Effect } from "effect"
import Anthropic from "@anthropic-ai/sdk"
import type { LLMShape, LLMError, Message, ToolDef, LLMResponse } from "../LLM.js"

export interface CacheMetrics {
  cacheHits: number
  cacheInvalidations: number
  tokensCached: number
}

const MODEL = () => process.env.GATES_MODEL ?? "claude-sonnet-4-6"

export const makeAnthropicProvider = (apiKey: string): LLMShape => {
  const client = new Anthropic({ apiKey })

  // Session-level metrics (survives across all complete() calls)
  let cacheHits = 0
  let cacheInvalidations = 0
  let tokensCached = 0

  const complete = (
    messages: Message[],
    tools: ToolDef[],
    system?: string
  ): Effect.Effect<LLMResponse, LLMError> =>
    Effect.gen(function* () {
      const systemParam = system
        ? ([{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }] as const)
        : undefined

      const apiMessages: Anthropic.MessageParam[] = messages.map((m) => {
        if (m.role === "tool") {
          return {
            role: "user" as const,
            content: m.results.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.id,
              content: r.content,
            })),
          } as const
        }
        return m as Anthropic.MessageParam
      })

      const apiTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }))

      let res: Anthropic.Message
      try {
        res = yield* Effect.tryPromise({
          try: () => client.messages.create({
            model: MODEL(),
            max_tokens: 8096,
            system: systemParam as unknown as string | undefined,
            tools: apiTools,
            messages: apiMessages,
          } as Parameters<typeof client.messages.create>[0]).then((r) => r as unknown as Anthropic.Message),
          catch: (e) => ({ _tag: "LLMError" as const, cause: e } as LLMError),
        })
        tokensCached += res.usage.input_tokens
        cacheHits++
      } catch (error: unknown) {
        const err = error as { _tag?: string; code?: string; status?: number }
        if (err.code === "cache_not_available" || err.status === 400) {
          cacheInvalidations++
          res = yield* Effect.tryPromise({
            try: () => client.messages.create({
              model: MODEL(),
              max_tokens: 8096,
              system: system,
              tools: apiTools,
              messages: apiMessages,
            } as Parameters<typeof client.messages.create>[0]).then((r) => r as unknown as Anthropic.Message),
            catch: (e) => ({ _tag: "LLMError" as const, cause: e } as LLMError),
          })
        } else if (err._tag === "LLMError") {
          return yield* Effect.fail(err as LLMError)
        } else {
          return yield* Effect.fail({ _tag: "LLMError" as const, cause: error })
        }
      }

      return {
        stop_reason: res.stop_reason,
        content: res.content,
        usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
        tool_calls: res.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input })),
      } as LLMResponse
    })

  const getCacheMetrics = (): Effect.Effect<CacheMetrics> =>
    Effect.sync(() => ({ cacheHits, cacheInvalidations, tokensCached }))

  return { complete, getCacheMetrics }
}
