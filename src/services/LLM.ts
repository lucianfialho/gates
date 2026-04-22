import { Context, Effect, Layer } from "effect"
import Anthropic from "@anthropic-ai/sdk"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ToolCall } from "../gates/Gate.js"

const execFileAsync = promisify(execFile)

const readClaudeAuth = async (): Promise<{ apiKey?: string; authToken?: string }> => {
  // prefer explicit API key
  if (process.env["ANTHROPIC_API_KEY"]) {
    return { apiKey: process.env["ANTHROPIC_API_KEY"] }
  }
  // fall back to Claude Code OAuth token from macOS Keychain
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password", "-s", "Claude Code-credentials", "-w",
    ])
    const creds = JSON.parse(stdout.trim()) as {
      claudeAiOauth?: { accessToken?: string }
    }
    const token = creds.claudeAiOauth?.accessToken
    if (token) return { authToken: token }
  } catch { /* keychain not available or no entry */ }
  return {}
}

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

const makeImpl: Effect.Effect<LLMShape> = Effect.gen(function* () {
  const auth = yield* Effect.promise(readClaudeAuth)
  const client = new Anthropic(auth)

  const complete = (
    messages: Message[],
    tools: ToolDef[],
    system?: string
  ): Effect.Effect<LLMResponse, LLMError> =>
    Effect.tryPromise({
      try: () =>
        client.messages.create({
          model: "claude-opus-4-7",
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
        tool_calls: res.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input })),
      }))
    )

  return { complete }
})

export const LLMLayer = Layer.effect(LLMService)(makeImpl)
