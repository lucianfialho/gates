import { Context, Effect, Layer } from "effect"
import type Anthropic from "@anthropic-ai/sdk"
import type { ToolCall } from "../gates/Gate.js"
import { Auth, AuthLayer } from "../auth/Auth.js"
import { makeAnthropicProvider } from "./providers/Anthropic.js"
import { makeOpenAIProvider } from "./providers/OpenAI.js"

export class LLMError {
  readonly _tag = "LLMError" as const
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
  stop_reason: "end_turn" | "tool_use" | string | null
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

// GATES_PROVIDER=anthropic (default) | openai | openai-compat
// GATES_BASE_URL — override base URL for openai-compat providers (Ollama, MiniMax, etc.)
// GATES_MODEL — override model name

const makeImpl: Effect.Effect<LLMShape, never, Auth> = Effect.gen(function* () {
  const auth = yield* Auth
  const provider = process.env.GATES_PROVIDER ?? "anthropic"

  if (provider === "anthropic") {
    const apiKey = yield* auth.getApiKey()
    if (!apiKey) {
      console.error(
        "\nNo API key found. Run: gates auth set sk-ant-...\n" +
        "Or set ANTHROPIC_API_KEY env var.\n"
      )
      process.exit(1)
    }
    return makeAnthropicProvider(apiKey)
  }

  // openai or openai-compat (Ollama, MiniMax, etc.)
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.GATES_API_KEY ?? "ollama"
  const baseURL = process.env.GATES_BASE_URL  // e.g. http://localhost:11434/v1 for Ollama

  if (!apiKey || apiKey === "ollama" && !baseURL) {
    if (provider !== "openai") {
      console.error("\nSet GATES_BASE_URL for local providers (e.g. http://localhost:11434/v1)\n")
    } else {
      console.error("\nSet OPENAI_API_KEY env var.\n")
      process.exit(1)
    }
  }

  return makeOpenAIProvider(apiKey, baseURL)
})

export const LLMLayer = Layer.effect(LLMService)(makeImpl).pipe(
  Layer.provide(AuthLayer)
)
