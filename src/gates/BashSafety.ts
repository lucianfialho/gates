import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { GateError, type Gate, type ToolCall } from "./Gate.js"

const block = (gate: string, reason: string) =>
  Effect.fail(new GateError(gate, reason))

const pass = Effect.void

// --- force-push to main/master ---

const checkForcePush = (cmd: string): Effect.Effect<void, GateError> => {
  const isForce = /git\s+push\s+.*--force/.test(cmd)
  const isProtected = /\b(main|master)\b/.test(cmd)
  if (isForce && isProtected) {
    return block(
      "bash-safety/force-push",
      "Force-push to main/master is blocked. Use a regular push or open a PR."
    )
  }
  return pass
}

// --- npm run <script> must exist in package.json ---

const loadPackageScripts = (): Effect.Effect<string[]> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile("package.json", "utf-8")
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
      return Object.keys(pkg.scripts ?? {})
    },
    catch: () => [],
  }).pipe(Effect.orElseSucceed(() => [] as string[]))

const checkNpmScript = (cmd: string): Effect.Effect<void, GateError> => {
  const match = /npm\s+run\s+(\S+)/.exec(cmd)
  if (!match) return pass
  const script = match[1]!

  return loadPackageScripts().pipe(
    Effect.flatMap((scripts) => {
      if (scripts.length === 0) return pass
      if (scripts.includes(script)) return pass
      return block(
        "bash-safety/npm-script",
        `Script "${script}" not found in package.json. Available: ${scripts.join(", ")}`
      )
    })
  )
}

// --- rm / mv / cp on paths that don't exist ---

const FILE_OP_RE = /\b(rm|mv|cp)\s+(?:-\S+\s+)*(\S+)/

const checkFileOp = (cmd: string): Effect.Effect<void, GateError> => {
  const match = FILE_OP_RE.exec(cmd)
  if (!match) return pass
  const op = match[1]!
  const path = match[2]!
  if (path.startsWith("-")) return pass
  if (!existsSync(path)) {
    return block(
      "bash-safety/file-op",
      `"${op} ${path}" — path does not exist.`
    )
  }
  return pass
}

// --- assembled gate ---

export const bashSafetyGate: Gate = {
  name: "bash-safety",
  matches: (call: ToolCall) => call.name === "bash",
  check: (call: ToolCall) => {
    const cmd = (call.input as { command?: string }).command ?? ""
    return Effect.all([
      checkForcePush(cmd),
      checkNpmScript(cmd),
      checkFileOp(cmd),
    ], { concurrency: "unbounded", discard: true })
  },
}
