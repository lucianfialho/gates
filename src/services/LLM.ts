import { Context, Effect, Layer } from "effect"
import type Anthropic from "@anthropic-ai/sdk"
import type { ToolCall } from "../gates/Gate.js"
import { Auth, AuthLayer } from "../auth/Auth.js"
import { makeAnthropicProvider } from "./providers/Anthropic.js"
import { makeOpenAIProvider } from "./providers/OpenAI.js"
import { getProviderConfig } from "../config/GatesConfig.js"

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

// Provider resolved from (in order): env vars → .gates/config.yaml → defaults
// API keys resolved from: env vars → ~/.local/share/gates/auth.json

const makeImpl: Effect.Effect<LLMShape, never, Auth> = Effect.gen(function* () {
  const auth = yield* Auth
  const { provider, model, baseURL } = yield* Effect.promise(() => getProviderConfig())

  process.env.GATES_MODEL = model  // make model available to providers

  if (provider === "anthropic") {
    const apiKey = yield* auth.getApiKey("anthropic")
    if (!apiKey) {
      console.error(
        `\nNo Anthropic API key found.\n` +
        `  Run: gates auth set sk-ant-...\n` +
        `  Or:  ANTHROPIC_API_KEY=sk-ant-... gates <command>\n`
      )
      process.exit(1)
    }
    return makeAnthropicProvider(apiKey)
  }

  // openai-compatible: openai, minimax, ollama, etc.
  const apiKey = yield* auth.getApiKey(provider)
  if (!apiKey && provider !== "ollama") {
    console.error(
      `\nNo API key found for provider "${provider}".\n` +
      `  Run: gates auth set ${provider} <key>\n` +
      `  Or:  GATES_API_KEY=<key> gates <command>\n`
    )
    process.exit(1)
  }

  return makeOpenAIProvider(apiKey ?? "ollama", baseURL)
})

export const LLMLayer = Layer.effect(LLMService)(makeImpl).pipe(
  Layer.provide(AuthLayer)
)
