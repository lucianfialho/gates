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

// Replace stale file-read results with a placeholder so they don't
// accumulate in the message history across many tool-call rounds.
// Elide older duplicate reads — keeps only the LATEST read of each path+range.
// Agent only sees [cached] when it already re-read that range later, so it
// has no reason to re-read again.
const elideStaleReads = (messages: Message[]): Message[] => {
  // Build label map: tool_id → human-readable label
  const toolLabels = new Map<string, string>()
  // Track which turn each tool_id was called in
  const idToTurn = new Map<string, number>()
  // Track the latest turn each label appears in
  const latestTurnForLabel = new Map<string, number>()

  let turn = 0
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue
      const input = block.input as Record<string, unknown>
      let label: string | null = null
      if (block.name === "read" || block.name === "read_lines") {
        const range = input["start"] != null ? `:${input["start"]}-${input["end"]}` : ""
        label = `${block.name}(${input["path"] ?? "?"}${range})`
      } else if (block.name === "grep") {
        label = `grep("${input["pattern"]}", ${input["path"]})`
      }
      if (label) {
        toolLabels.set(block.id, label)
        idToTurn.set(block.id, turn)
        const prev = latestTurnForLabel.get(label) ?? -1
        if (turn > prev) latestTurnForLabel.set(label, turn)
      }
    }
    turn++
  }

  return messages.map((msg) => {
    if (msg.role !== "tool") return msg
    return {
      ...msg,
      results: msg.results.map((r) => {
        const label = toolLabels.get(r.id)
        if (!label) return r
        const myTurn = idToTurn.get(r.id) ?? -1
        const latestTurn = latestTurnForLabel.get(label) ?? -1
        // Only elide if this same label was read again in a LATER turn
        if (myTurn < latestTurn) {
          return { id: r.id, content: `[duplicate: ${label} — use the later result]` }
        }
        return r
      }),
    }
  })
}

const executeToolCalls = (
  runId: string,
  calls: ToolCall[],
  onEvent?: (event: ChatEvent) => void
): Effect.Effect<ToolResult[], AgentError | GateError, RunDeps> =>
  Effect.gen(function* () {
    const gates = yield* GateRegistry
    const tools = yield* ToolRegistry
    const persistence = yield* Persistence

    return yield* Effect.forEach(
      calls,
      (call: ToolCall) =>
        Effect.gen(function* () {
          // Enforce gates and measure duration
          const gateStart = performance.now()
          yield* gates.enforce(call)
          const gateDuration = Math.round(performance.now() - gateStart)

          // Record gate_pass before tool execution
          yield* persistence.record(runId, {
            type: "gate_pass",
            gate: "enforced",
            tool: call.name,
            ts: now(),
            duration: gateDuration,
          })

          // Execute the tool and measure duration
          const toolStart = performance.now()
          yield* persistence.record(runId, {
            type: "tool_call",
            tool: call.name,
            tool_use_id: call.id,
            ts: now(),
          })

          const result = yield* tools.execute(call.id, call.name, call.input).pipe(
            Effect.catchTag("ToolError", (e: ToolError) =>
              Effect.succeed({ id: call.id, content: `Error: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}` })
            )
          )

          const toolDuration = Math.round(performance.now() - toolStart)

          // Record tool_result event
          yield* persistence.record(runId, {
            type: "tool_result",
            results: [result],
            ts: now(),
            duration: toolDuration,
          })

          return result
        }).pipe(
          Effect.catchTag("GateError", (e) => {
            const blockStart = performance.now()
            onEvent?.({ type: "gate_block", gate: e.gate, reason: e.reason })
            // Return block message as tool result so agent can recover
            // (use grep, use read_lines, etc.) rather than crashing the state
            return persistence
              .record(runId, {
                type: "gate_block",
                gate: e.gate,
                reason: e.reason,
                call,
                ts: now(),
                duration: Math.round(performance.now() - blockStart),
              })
              .pipe(Effect.map(() => ({ id: call.id, content: `[BLOCKED by ${e.gate}]: ${e.reason}` })))
          }),
        ),
      { concurrency: 1 }
    )
  })

export interface RunResult {
  text: string
  usage: { input_tokens: number; output_tokens: number }
}

export type ChatEvent =
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string }
  | { type: "gate_block"; gate: string; reason: string }
  | { type: "thinking"; text: string }
  | { type: "state_change"; state: string; step: number; total: number }
  | { type: "text"; text: string }
  | { type: "done"; usage: { input_tokens: number; output_tokens: number } }

export const run = (
  prompt: string,
  systemPrompt?: string,
  parentRunId?: string,
  verbose?: boolean,
  onEvent?: (event: ChatEvent) => void
): Effect.Effect<RunResult, AgentError | GateError, RunDeps> =>
  Effect.gen(function* () {
    const llm = yield* LLMService
    const tools = yield* ToolRegistry
    const persistence = yield* Persistence

    const runId = yield* persistence.initRun(prompt, parentRunId)

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
          const rawMessages = yield* Ref.get(messagesRef)
          const messages = elideStaleReads(rawMessages)

          // Measure llm_request duration
          const reqStart = performance.now()
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

          // Measure llm_response duration
          const reqDuration = Math.round(performance.now() - reqStart)
          yield* persistence.record(runId, {
            type: "llm_response",
            stop_reason: response.stop_reason,
            tool_calls: response.tool_calls,
            usage: response.usage,
            ts: now(),
            duration: reqDuration,
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
            if (result) onEvent?.({ type: "text", text: result })
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

          if (verbose) {
            for (const call of response.tool_calls) {
              console.error(`[gates] tool call: ${call.name} ${JSON.stringify(call.input)}`)
            }
          }

          // Emit intermediate text (agent reasoning before tool calls)
          const thinkingBlock = response.content.find((b) => b.type === "text")
          if (thinkingBlock?.type === "text" && thinkingBlock.text.trim()) {
            const cleaned = thinkingBlock.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
            if (cleaned) onEvent?.({ type: "thinking", text: cleaned })
          }

          for (const call of response.tool_calls) {
            onEvent?.({ type: "tool_call", name: call.name, input: call.input })
          }

          const results = yield* executeToolCalls(runId, response.tool_calls, onEvent)

          for (const result of results) {
            onEvent?.({ type: "tool_result", id: result.id, content: result.content.slice(0, 200) })
            if (verbose) {
              console.error(`[gates] tool result: ${result.id} ${result.content.slice(0, 200)}`)
            }
          }

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
    onEvent?.({ type: "done", usage: totalUsage })
    return { text: (yield* Ref.get(resultRef)) ?? "", usage: totalUsage }
  })
