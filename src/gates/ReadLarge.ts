import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join, isAbsolute } from "node:path"

import { GateError, type Gate, type ToolCall } from "./Gate.js"

const MAX_LINES = 120

const block = (gate: string, reason: string) =>
  Effect.fail(new GateError(gate, reason))

const pass = Effect.void

const countLines = (path: string): number => {
  try {
    const abs = isAbsolute(path) ? path : join(process.cwd(), path)
    const content = readFileSync(abs, "utf-8")
    return content.split("\n").length
  } catch {
    return 0  // unreadable → don't block
  }
}

export const readLargeGate: Gate = {
  name: "read-large",
  matches: (call: ToolCall) => call.name === "read",
  check: (call: ToolCall) => {
    const { path } = call.input as { path?: string }
    if (!path) return pass

    const lines = countLines(path)
    if (lines <= MAX_LINES) return pass

    return block(
      "read-large",
      `${path} has ${lines} lines — too large to read whole.\n` +
      `1. Use grep(pattern, "${path}") to find the relevant section\n` +
      `2. Then use read_lines(path, start, end) for that range only\n` +
      `Tip: grep returns line numbers you can pass directly to read_lines.`
    )
  },
}
