import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { Gate, GateError, type ToolCall } from "./Gate.js"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RelevantPathsFileError extends GateError {
  constructor(readonly reason: string) { super("SelectiveContextGate", "RelevantPathsFileError") }
}

export class FileNotInRelevantScopeError extends GateError {
  constructor(readonly path: string, readonly relevantPaths: string[]) {
    super("SelectiveContextGate", "FileNotInRelevantScope")
  }
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * selectiveContextGate — enforce "analyze_only" context scoping.
 *
 * How it works
 * ────────────
 * - `gates.config.json` contains a `context_scope` option.
 * - `.gates/context.yaml` contains the current `phase` field.
 * - `.gates/relevant.json` is written after the **analyze** step and holds
 *   the array of file-paths the model marked relevant.
 *
 * When `context_scope === "analyze_only"` and `phase !== "analyze"`,
 * every file-related tool call is checked against `relevant.json`.
 * Files not listed there are blocked.
 */
export const selectiveContextGate: Gate = {
  name: "SelectiveContextGate",
  matches: (call: ToolCall) =>
    ["read", "read_lines", "edit", "write", "write_lines", "glob", "grep", "bash"].includes(call.name),

  check: (call: ToolCall) =>
    Effect.tryPromise({
      try: async () => {
        // ── 1. Load config (context_scope) ──────────────────────────────────
        const cwd = process.cwd()
        let scope: "full" | "analyze_only" | undefined
        try {
          const raw = await readFile(join(cwd, "gates.config.json"), "utf-8")
          const cfg = JSON.parse(raw) as { context_scope?: "full" | "analyze_only" }
          scope = cfg.context_scope
        } catch { /* no config → treat as unset */ }

        if (scope !== "analyze_only") return

        // ── 2. Load current phase from .gates/context.yaml ──────────────────
        let phase = "analyze"
        try {
          const { parse } = await import("yaml")
          const raw = await readFile(join(cwd, ".gates", "context.yaml"), "utf-8")
          const ctx = parse(raw) as { phase?: string }
          phase = (ctx.phase as "analyze" | "implement" | "verify") ?? "analyze"
        } catch { /* file not there yet → analyze phase, gate passes */ }

        if (phase === "analyze") return

        // ── 3. Load relevant paths from .gates/relevant.json ───────────────
        let relevantPaths: string[] = []
        try {
          const raw = await readFile(join(cwd, ".gates", "relevant.json"), "utf-8")
          relevantPaths = JSON.parse(raw) as string[]
        } catch { /* not written yet → no restriction */ }

        if (relevantPaths.length === 0) return  // fallback to full tree

        // ── 4. Enforce ───────────────────────────────────────────────────────
        const paths = extractFilePaths(call)
        const outside = paths.filter((p) => !isCoveredBy(p, relevantPaths))
        if (outside.length > 0) {
          throw new GateError(
            "SelectiveContextGate",
            `File "${outside[0]}" is not in the relevant set from analyze step. ` +
            `Allowed: ${JSON.stringify(relevantPaths)}`
          )
        }
      },
      catch: (e) =>
        e instanceof GateError
          ? e
          : new GateError("SelectiveContextGate", e instanceof Error ? e.message : String(e)),
    }),
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract all file-path strings referenced in a ToolCall's input. */
export const extractFilePaths = (call: ToolCall): string[] => {
  const paths: string[] = []
  const input = call.input as Record<string, unknown>

  // For bash calls, scan the command string too (has multi-token paths)
  const valuesToScan: unknown[] =
    call.name === "bash" && typeof input["command"] === "string"
      ? [input["command"], input]
      : [input]

  for (const val of valuesToScan) {
    scanValue(val)
  }

  function scanValue(v: unknown): void {
    if (typeof v === "string") {
      extractFromString(v, paths)
    } else if (Array.isArray(v)) {
      v.forEach(scanValue)
    } else if (v !== null && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(scanValue)
    }
  }

  return paths
}

const PATH_START_RE = /(?:^|[ \t\n'"`<>])(src\/|\.\/|\.\.\/|\/)/g

function extractFromString(s: string, out: string[]): void {
  let i = 0
  while (i < s.length) {
    const match = PATH_START_RE.exec(s.slice(i))
    if (!match) break

    const rel = match[1]!
    const tokenStart = i + match.index + match[0]!.lastIndexOf(rel)
    const tokenRaw = s.slice(tokenStart, tokenStart + 200)
    const tokenEnd = Math.min(
      tokenRaw.search(/[ \t\n'"`<>|]/),
      tokenRaw.length
    )
    const token = tokenEnd > 0 ? tokenRaw.slice(0, tokenEnd) : tokenRaw
    if (token.length > 0) out.push(token)

    i = tokenStart + token.length
    PATH_START_RE.lastIndex = 0
  }
}

/** Returns true if `path` is inside (or exactly matches) one of the relevant roots. */
const isCoveredBy = (path: string, relevantPaths: string[]): boolean => {
  const p = path.replace(/^\.\//, "")
  return relevantPaths.some((r) => p.startsWith(r) || r.startsWith(p))
}

// ---------------------------------------------------------------------------
// Prompt builder — filters content to only relevant paths
// ---------------------------------------------------------------------------

export interface BuildPromptInput {
  systemPrompt: string
  relevantPaths: string[]
}

/**
 * Returns a filtered system prompt that only mentions files in `relevantPaths`.
 * Files not in the list are stripped from the prompt content.
 *
 * This is consumed by the Runner / Loop when building messages for the LLM.
 */
export const filterContextToRelevant = (input: BuildPromptInput): string => {
  const { systemPrompt, relevantPaths } = input
  if (!relevantPaths.length) return systemPrompt

  const keep = new Set(relevantPaths)
  return systemPrompt
    .split("\n")
    .filter((line) => {
      if (!line.includes("src/")) return true
      return keep.has(line.trim())
    })
    .join("\n")
}
