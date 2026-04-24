import { Effect } from "effect"
import { GateError, type Gate, type ToolCall } from "./Gate.js"

const block = (gate: string, reason: string) =>
  Effect.fail(new GateError(gate, reason))

const pass = Effect.void

const WRITE_TOOLS = new Set(["write", "write_lines", "edit"])

// Detects recursive gates invocations in bash commands (e.g. `bun src/index.ts doctor`)
// which would create nested sessions and trigger LLMService-not-found errors.
const RECURSIVE_GATES_RE = /bun\s+src\/index\.ts\b|gates\s+(?!run\s+typecheck|doctor|version|stats|logs|clean|help)/

export const verifyReadOnlyGate: Gate = {
  name: "verify-readonly",
  matches: (call: ToolCall) => WRITE_TOOLS.has(call.name) || call.name === "bash",
  check: (call: ToolCall) => {
    const activeState = process.env["GATES_ACTIVE_STATE"] ?? ""
    if (activeState !== "verify") return pass

    if (call.name === "bash") {
      const cmd = String((call.input as Record<string, unknown>)["command"] ?? "")
      if (RECURSIVE_GATES_RE.test(cmd)) {
        return block(
          "verify-readonly/recursive",
          `Blocked: "${cmd.slice(0, 80)}" — do not invoke the gates binary recursively in verify.\n` +
          `Use GATES_NO_LLM=1 bun src/index.ts <cmd> for simple commands, or bun run typecheck for validation.`
        )
      }
      return pass
    }

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
