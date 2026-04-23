import { Effect } from "effect"
import OpenAI from "openai"
import type Anthropic from "@anthropic-ai/sdk"
import type { LLMShape, LLMError, Message, ToolDef, LLMResponse } from "../LLM.js"

const MODEL = () => process.env.GATES_MODEL ?? "gpt-4o-mini"

// Convert our internal Message[] (Anthropic-style) to OpenAI message format
const toOpenAIMessages = (messages: Message[]): OpenAI.ChatCompletionMessageParam[] => {
  const result: OpenAI.ChatCompletionMessageParam[] = []

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content })
      continue
    }

    if (msg.role === "tool") {
      for (const r of msg.results) {
        result.push({ role: "tool", tool_call_id: r.id, content: r.content })
      }
      continue
    }

    // assistant — content is Anthropic.ContentBlock[]
    const textBlock = msg.content.find((b) => b.type === "text")
    const toolUseBlocks = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")

    result.push({
      role: "assistant",
      content: textBlock?.type === "text" ? textBlock.text : null,
      ...(toolUseBlocks.length > 0 ? {
        tool_calls: toolUseBlocks.map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        })),
      } : {}),
    } as OpenAI.ChatCompletionMessageParam)
  }

  return result
}

// Convert OpenAI response back to our Anthropic-style ContentBlock[]
const toContentBlocks = (choice: OpenAI.ChatCompletion["choices"][0]): Anthropic.ContentBlock[] => {
  const blocks: Anthropic.ContentBlock[] = []

  if (choice.message.content) {
    blocks.push({ type: "text", text: choice.message.content } as Anthropic.TextBlock)
  }

  for (const tc of choice.message.tool_calls ?? []) {
    const fn = tc.type === "function" ? tc.function : null
    let input: unknown = {}
    try { input = JSON.parse(fn?.arguments ?? "{}") } catch { /* keep {} */ }
    blocks.push({
      type: "tool_use",
      id: tc.id,
      name: fn?.name ?? "",
      input,
    } as Anthropic.ToolUseBlock)
  }

  return blocks
}

export const makeOpenAIProvider = (apiKey: string, baseURL?: string): LLMShape => {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })

  const complete = (
    messages: Message[],
    tools: ToolDef[],
    system?: string
  ): Effect.Effect<LLMResponse, LLMError> =>
    Effect.tryPromise({
      try: async () => {
        const systemMessages: OpenAI.ChatCompletionMessageParam[] = system
          ? [{ role: "system", content: system }]
          : []

        const res = await client.chat.completions.create({
          model: MODEL(),
          max_tokens: 8096,
          messages: [...systemMessages, ...toOpenAIMessages(messages)],
          ...(tools.length > 0 ? {
            tools: tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
              },
            })),
            tool_choice: "auto" as const,
          } : {}),
        })

        const choice = res.choices[0]!
        const content = toContentBlocks(choice)
        const stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn"

        return {
          stop_reason: stopReason as "tool_use" | "end_turn",
          content,
          usage: {
            input_tokens: res.usage?.prompt_tokens ?? 0,
            output_tokens: res.usage?.completion_tokens ?? 0,
          },
          tool_calls: (choice.message.tool_calls ?? []).map((tc) => {
            const fn = tc.type === "function" ? tc.function : null
            let input: unknown = {}
            try { input = JSON.parse(fn?.arguments ?? "{}") } catch { /* keep {} */ }
            return { id: tc.id, name: fn?.name ?? "", input }
          }),
        } satisfies LLMResponse
      },
      catch: (e): LLMError => ({ _tag: "LLMError" as const, cause: e }),
    })

  return { complete }
}
