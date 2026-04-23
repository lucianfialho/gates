import { Effect } from "effect"
import { GateError, type Gate, type ToolCall } from "./Gate.js"

const block = (gate: string, reason: string) =>
  Effect.fail(new GateError(gate, reason))

const pass = Effect.void

// Per-process history — one process = one CLI run, so this never needs resetting
// for the CLI case. TUI resets are handled via clearReadHistory().
const readHistory = new Set<string>()

export const clearReadHistory = () => readHistory.clear()

const makeKey = (call: ToolCall): string | null => {
  const input = call.input as Record<string, unknown>
  if (call.name === "read_lines") {
    return `read_lines:${input["path"]}:${input["start"]}-${input["end"]}`
  }
  if (call.name === "grep") {
    return `grep:${input["pattern"]}:${input["path"]}`
  }
  return null
}

export const readDedupGate: Gate = {
  name: "read-dedup",
  matches: (call: ToolCall) =>
    call.name === "read_lines" || call.name === "grep",
  check: (call: ToolCall) => {
    const key = makeKey(call)
    if (!key) return pass

    if (readHistory.has(key)) {
      return block(
        "read-dedup",
        `Already fetched: ${key}\n` +
        `The result is visible earlier in this conversation — use it directly.\n` +
        `Do NOT re-fetch the same range. If you need a different section, use a different range.`
      )
    }

    readHistory.add(key)
    return pass
  },
}
