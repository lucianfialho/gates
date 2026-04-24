import { Effect } from "effect"
import { realpathSync } from "node:fs"
import { resolve, isAbsolute } from "node:path"

import { GateError, type Gate, type ToolCall } from "./Gate.js"

const block = (gate: string, reason: string) =>
  Effect.fail(new GateError(gate, reason))

const pass = Effect.void

const CWD = process.cwd()

// Resolve path to absolute, then check it's within CWD.
// realpathSync resolves symlinks — prevents symlink traversal outside workspace.
const resolveAndCheck = (path: string): string | null => {
  try {
    const abs = isAbsolute(path) ? path : resolve(CWD, path)
    // Check before resolving symlinks (file may not exist yet for writes)
    if (!abs.startsWith(CWD + "/") && abs !== CWD) return null
    // For existing files/dirs, also check after symlink resolution
    try {
      const real = realpathSync(abs)
      if (!real.startsWith(CWD + "/") && real !== CWD) return null
    } catch {
      // File doesn't exist yet (write) — pre-check is enough
    }
    return abs
  } catch {
    return null
  }
}

const FILE_TOOLS = new Set(["read", "write", "edit", "read_lines", "write_lines"])

export const workspaceBoundaryGate: Gate = {
  name: "workspace-boundary",
  matches: (call: ToolCall) => FILE_TOOLS.has(call.name),
  check: (call: ToolCall) => {
    const input = call.input as Record<string, unknown>
    const path = String(input["path"] ?? input["file_path"] ?? "")
    if (!path) return pass

    const resolved = resolveAndCheck(path)
    if (!resolved) {
      return block(
        "workspace-boundary",
        `Path "${path}" is outside the workspace (${CWD}).\n` +
        `Only files within the current working directory are accessible.`
      )
    }

    return pass
  },
}
