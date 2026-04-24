import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join, isAbsolute } from "node:path"

import { GateError, type Gate, type ToolCall } from "./Gate.js"

const MAX_LINES = 150

const block = (gate: string, reason: string) =>
  Effect.fail(new GateError(gate, reason))

const pass = Effect.void

const countLines = (content: string): number => content.split("\n").length

const existingLines = (path: string): number => {
  try {
    const abs = isAbsolute(path) ? path : join(process.cwd(), path)
    return readFileSync(abs, "utf-8").split("\n").length
  } catch {
    return 0
  }
}

const EXEMPT = [".metadata/", ".gates/", "package.json", "tsconfig", ".yaml", ".yml", ".md", ".json", ".test."]

const isExempt = (path: string) => EXEMPT.some(pat => path.includes(pat))

export const writeLargeGate: Gate = {
  name: "write-large",
  // Only check write (full file creation/replacement) — edit is always targeted,
  // and blocking edit on already-large files prevents any fix to those files.
  matches: (call: ToolCall) => call.name === "write",
  check: (call: ToolCall) => {
    const input = call.input as Record<string, unknown>
    const path = String(input["path"] ?? input["file_path"] ?? "")
    if (!path || isExempt(path)) return pass

    const content = String(input["content"] ?? "")
    const resultLines = countLines(content)

    if (resultLines <= MAX_LINES) return pass

    return block(
      "write-large",
      `${path} would have ${resultLines} lines after this write (limit: ${MAX_LINES}).\n` +
      `Extract the new code to a smaller file first:\n` +
      `  • Commands → src/commands/<name>.ts\n` +
      `  • Utilities → src/utils/<name>.ts\n` +
      `  • Types → src/types/<name>.ts\n` +
      `Then import it in ${path}.\n` +
      `If this is a deliberate refactor of the file, use @refactor split ${path}.`
    )
  },
}
