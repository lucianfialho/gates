import { Effect } from "effect"
import { GateError, type Gate, type ToolCall } from "./Gate.js"

const block = (gate: string, reason: string) =>
  Effect.fail(new GateError(gate, reason))

const pass = Effect.void

// Tools that should be bundled into execute_code instead of called individually.
// The agent can do grep, read_lines, and readFile inside execute_code — they
// run in the sandbox at zero additional context cost. Individual calls each add
// a round-trip message to the history, causing O(N) token growth per operation.
//
// Exempt: read (small files), write, edit, bash, glob, mode_switch, execute_code itself.
// read is exempt because read-large already gates it; small files are fine individually.
const BUNDLE_TOOLS = new Set(["grep", "read_lines"])

export const executeCodeEnforceGate: Gate = {
  name: "execute-code-enforce",
  matches: (call: ToolCall) => BUNDLE_TOOLS.has(call.name),
  check: (call: ToolCall) => {
    const input = call.input as Record<string, unknown>

    if (call.name === "grep") {
      const pattern = String(input["pattern"] ?? "")
      const path = String(input["path"] ?? "")
      return block(
        "execute-code-enforce",
        `Use execute_code instead of grep — bundle multiple operations in one round:\n` +
        `  execute_code(\`\n` +
        `    const result = await grep("${pattern}", "${path}")\n` +
        `    console.log(result)\n` +
        `  \`)`
      )
    }

    if (call.name === "read_lines") {
      const path = String(input["path"] ?? "")
      const start = input["start"]
      const end = input["end"]
      return block(
        "execute-code-enforce",
        `Use execute_code instead of read_lines — bundle multiple operations in one round:\n` +
        `  execute_code(\`\n` +
        `    const content = await readLines("${path}", ${start}, ${end})\n` +
        `    console.log(content)\n` +
        `  \`)`
      )
    }

    return pass
  },
}
