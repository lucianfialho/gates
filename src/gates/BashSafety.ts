import { Effect } from "effect"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

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

const loadPackageScripts = (): string[] => {
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf-8")
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
    return Object.keys(pkg.scripts ?? {})
  } catch {
    return []
  }
}

const checkNpmScript = (cmd: string): Effect.Effect<void, GateError> => {
  const match = /npm\s+run\s+(\S+)/.exec(cmd)
  if (!match) return pass
  const script = match[1]!

  const scripts = loadPackageScripts()
  if (scripts.length === 0) return pass          // no scripts in package.json
  if (scripts.includes(script)) return pass     // script is whitelisted
  return block(
    "bash-safety/npm-script",
    `Script "${script}" not found in package.json. Available: ${scripts.join(", ")}`
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

// --- dangerous redirect/pipe patterns (from claw-code allowlist) ---
// Block shell redirects that could overwrite system files or inject data

// Files that are large and should never be cat'd directly
const LARGE_FILE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h)$/

const checkCatLargeFile = (cmd: string): Effect.Effect<void, GateError> => {
  const catMatch = /\bcat\s+(\S+)/.exec(cmd)
  if (!catMatch) return pass
  const path = catMatch[1]!
  if (LARGE_FILE_EXTENSIONS.test(path)) {
    return block(
      "bash-safety/cat-large",
      `cat ${path} is blocked — use execute_code with readFile() or readLines() instead.\n` +
      `Example: execute_code('const c = await readFile("${path}"); console.log(c)')`
    )
  }
  return pass
}

const DANGEROUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bcurl\b.*[|>]/, reason: "curl piped or redirected — potential remote code execution" },
  { re: /\bwget\b.*[|>]/, reason: "wget piped or redirected — potential remote code execution" },
  { re: />\s*\/etc\//, reason: "redirect to /etc/ — system file overwrite blocked" },
  { re: />\s*\/usr\//, reason: "redirect to /usr/ — system file overwrite blocked" },
  { re: /\bsudo\b/, reason: "sudo is not allowed in agent commands" },
  { re: /\bchmod\s+[0-7]*7[0-7]*\s+/, reason: "chmod giving world-write is blocked" },
]

const checkDangerousPatterns = (cmd: string): Effect.Effect<void, GateError> => {
  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) {
      return block("bash-safety/dangerous", reason)
    }
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
      checkDangerousPatterns(cmd),
      checkCatLargeFile(cmd),
    ], { concurrency: "unbounded", discard: true })
  },
}
