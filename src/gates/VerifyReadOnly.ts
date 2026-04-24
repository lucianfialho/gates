import { Effect } from "effect"
import { GateError, type Gate, type ToolCall } from "./Gate.js"

const block = (gate: string, reason: string) =>
  Effect.fail(new GateError(gate, reason))

const pass = Effect.void

const WRITE_TOOLS = new Set(["write", "write_lines", "edit"])

export const verifyReadOnlyGate: Gate = {
  name: "verify-readonly",
  matches: (call: ToolCall) => WRITE_TOOLS.has(call.name),
  check: (call: ToolCall) => {
    const activeState = process.env["GATES_ACTIVE_STATE"] ?? ""
    if (activeState !== "verify") return pass

    const input = call.input as Record<string, unknown>
    const path = String(input["path"] ?? input["file_path"] ?? "")

    return block(
      "verify-readonly",
      `Write blocked in verify state — verify must only run commands, not edit files.\n` +
      `File: ${path}\n` +
      `If the implementation is incomplete, the verify gate will return passed=false\n` +
      `and the Runner will handle returning to implement via HITL.`
    )
  },
}
