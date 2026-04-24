import { Context, Effect, Layer } from "effect"
import { spawn, execFile } from "node:child_process"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { glob as fsGlob } from "node:fs/promises"
import { promisify } from "node:util"
import type { ToolDef } from "./LLM.js"

const execFileAsync = promisify(execFile)

export class ToolError {
  readonly _tag = "ToolError"
  constructor(
    readonly tool: string,
    readonly cause: unknown
  ) {}
}

export interface ToolResult {
  readonly id: string
  readonly content: string
  readonly exitCode?: number
}

type ToolHandler = (id: string, input: unknown) => Effect.Effect<ToolResult, ToolError>

export interface ToolRegistryShape {
  readonly execute: (id: string, name: string, input: unknown) => Effect.Effect<ToolResult, ToolError>
  readonly definitions: ToolDef[]
}

export class ToolRegistry extends Context.Service<ToolRegistry, ToolRegistryShape>()(
  "gates/ToolRegistry"
) {}

const bash: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { command } = input as { command: string }

      return new Promise((resolve) => {
        const child = spawn("sh", ["-c", command], {
          stdio: ["ignore", "pipe", "pipe"],
        })

        let stdout = ""
        let stderr = ""
        let killed = false

        child.stdout?.on("data", (data) => {
          stdout += data.toString()
          if (stdout.length > 10_000_000) {
            stdout = stdout.slice(-10_000_000)
          }
        })

        child.stderr?.on("data", (data) => {
          stderr += data.toString()
        })

        child.on("close", (code, signal) => {
          const output = stdout + stderr
          const truncated = output.length > 10_000 ? output.slice(0, 10_000) + "\n[truncated]" : output
          resolve({
            id,
            content: truncated,
            exitCode: killed ? 1 : (code ?? (signal ? 1 : 0)),
          })
        })

        child.on("error", (err) => {
          const output = stdout + stderr
          const truncated = output.length > 10_000 ? output.slice(0, 10_000) + "\n[truncated]" : output
          resolve({ id, content: truncated + `\n[error: ${err.message}]`, exitCode: 1 })
        })

        // SIGTERM with 5s grace period then SIGKILL
        const GRACE_PERIOD_MS = 5_000
        let graceTimer: ReturnType<typeof setTimeout> | null = null

        const setupGracefulKill = () => {
          if (graceTimer) return
          graceTimer = setTimeout(() => {
            killed = true
            child.kill("SIGKILL")
          }, GRACE_PERIOD_MS)
        }

        process.on("SIGTERM", setupGracefulKill)
        child.on("exit", () => {
          process.off("SIGTERM", setupGracefulKill)
          if (graceTimer) {
            clearTimeout(graceTimer)
          }
        })
      })
    },
    catch: (e) => new ToolError("bash", e),
  })

const read: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { path } = input as { path: string }
      const content = await readFile(path, "utf-8")
      return { id, content }
    },
    catch: (e) => new ToolError("read", e),
  })

const write: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { path, content } = input as { path: string; content: string }
      await writeFile(path, content, "utf-8")
      return { id, content: `Written: ${path}` }
    },
    catch: (e) => new ToolError("write", e),
  })

const edit: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { path, old_string, new_string } = input as {
        path: string
        old_string: string
        new_string: string
      }
      const original = await readFile(path, "utf-8")
      const count = original.split(old_string).length - 1
      if (count === 0) throw new Error(`old_string not found in ${path}`)
      if (count > 1) throw new Error(`old_string matches ${count} times in ${path} — be more specific`)
      await writeFile(path, original.replace(old_string, new_string), "utf-8")
      return { id, content: `Edited: ${path}` }
    },
    catch: (e) => new ToolError("edit", e),
  })

const glob: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { pattern, cwd } = input as { pattern: string; cwd?: string }
      const matches: string[] = []
      for await (const file of fsGlob(pattern, { cwd: cwd ?? "." })) {
        matches.push(file)
      }
      matches.sort()
      return { id, content: matches.length > 0 ? matches.join("\n") : "(no matches)" }
    },
    catch: (e) => new ToolError("glob", e),
  })

const MAX_GREP_LINES = 150
const MAX_GREP_CHARS = 8_000

const grep: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { pattern, path, case_sensitive = true } = input as {
        pattern: string
        path: string
        case_sensitive?: boolean
      }
      const flag = case_sensitive ? "" : "-i"
      const { stdout } = await execFileAsync(
        "grep",
        ["-rn", "--include=*", flag, pattern, path].filter(Boolean),
        { timeout: 15_000 }
      ).catch((e: { stdout?: string; code?: number }) => {
        if (e.code === 1) return { stdout: "" }  // no matches — not an error
        throw e
      })
      const lines = stdout.trim().split("\n")
      const limited = lines.slice(0, MAX_GREP_LINES).join("\n").slice(0, MAX_GREP_CHARS)
      const suffix = lines.length > MAX_GREP_LINES
        ? `\n… (${lines.length - MAX_GREP_LINES} more lines — use read_lines for specific sections)`
        : ""
      return {
        id,
        content: limited ? limited + suffix : "(no matches)",
      }
    },
    catch: (e) => new ToolError("grep", e),
  })

const read_lines: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { path, start, end } = input as { path: string; start: number; end: number }
      const content = await readFile(path, "utf-8")
      const lines = content.split("\n")
      const total = lines.length
      if (start < 1 || start > total) throw new Error(`start=${start} is out of range (file has ${total} lines)`)
      if (end < start || end > total) throw new Error(`end=${end} is out of range (start=${start}, file has ${total} lines)`)
      const selected = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join("\n")
      return { id, content: selected }
    },
    catch: (e) => new ToolError("read_lines", e),
  })

const write_lines: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { path, lines, ensure_newline = false } = input as {
        path: string
        lines: string[]
        ensure_newline?: boolean
      }
      if (ensure_newline) {
        let existing = ""
        try {
          existing = await readFile(path, "utf-8")
        } catch {
          // file doesn't exist yet — that's fine
        }
        if (existing.length > 0 && !existing.endsWith("\n")) {
          await appendFile(path, "\n", "utf-8")
        }
      }
      await appendFile(path, lines.join("\n") + "\n", "utf-8")
      return { id, content: `Appended ${lines.length} line(s) to: ${path}` }
    },
    catch: (e) => new ToolError("write_lines", e),
  })

const fetch_url: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { url, method = "GET", body, headers: extraHeaders } = input as {
        url: string
        method?: string
        body?: string
        headers?: Record<string, string>
      }
      const res = await fetch(url, {
        method,
        body: body ?? undefined,
        headers: {
          "User-Agent": "gates/0.1.0",
          ...(extraHeaders ?? {}),
        },
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      const truncated = text.length > 20_000 ? text.slice(0, 20_000) + "\n[truncated]" : text
      return { id, content: `HTTP ${res.status} ${res.statusText}\n\n${truncated}` }
    },
    catch: (e) => new ToolError("fetch", e),
  })

const gh_issue_read: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { number } = input as { number: number | string }
      const { stdout } = await execFileAsync("gh", ["issue", "view", String(number), "--json", "number,title,body,labels,state,url"])
      return { id, content: stdout.trim() }
    },
    catch: (e) => new ToolError("gh_issue_read", e),
  })

const gh_issue_list: ToolHandler = (id, _input) =>
  Effect.tryPromise({
    try: async () => {
      const { stdout } = await execFileAsync("gh", ["issue", "list", "--json", "number,title,state,labels", "--limit", "20"])
      return { id, content: stdout.trim() }
    },
    catch: (e) => new ToolError("gh_issue_list", e),
  })

const gh_issue_create: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { title, body, labels } = input as { title: string; body: string; labels?: string[] }
      const args = ["issue", "create", "--title", title, "--body", body]
      if (labels?.length) args.push("--label", labels.join(","))
      const { stdout } = await execFileAsync("gh", args)
      return { id, content: stdout.trim() }
    },
    catch: (e) => new ToolError("gh_issue_create", e),
  })

const gh_pr_create: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { title, body, base = "main" } = input as { title: string; body: string; base?: string }
      const { stdout } = await execFileAsync("gh", ["pr", "create", "--title", title, "--body", body, "--base", base])
      return { id, content: stdout.trim() }
    },
    catch: (e) => new ToolError("gh_pr_create", e),
  })

// execute_code — agent writes JavaScript, executed in a sandboxed context
// with all tools injected as async functions. console.log output is returned.
// Solves O(N²) message history growth: multiple operations in one round.
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Function

const BLOCKED_CODE_PATTERNS = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /__proto__/,
  /process\.env/,
  /process\.exit/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
]

const execute_code: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { code } = input as { code: string }

      // Safety check before execution
      for (const pattern of BLOCKED_CODE_PATTERNS) {
        if (pattern.test(code)) {
          return { id, content: `[BLOCKED by code-safety]: pattern "${pattern.source}" is not allowed` }
        }
      }

      const output: string[] = []
      const fakeConsole = {
        log: (...args: unknown[]) =>
          output.push(args.map(a => typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)).join(" ")),
        error: (...args: unknown[]) =>
          output.push("[error] " + args.join(" ")),
        warn: (...args: unknown[]) =>
          output.push("[warn] " + args.join(" ")),
      }

      // Toolkit: simple async wrappers over the underlying implementations
      const toolkit = {
        readFile: async (path: string): Promise<string> => {
          const content = await readFile(path, "utf-8")
          return content.length > 50_000 ? content.slice(0, 50_000) + "\n[truncated]" : content
        },
        readLines: async (path: string, start: number, end: number): Promise<string> => {
          const content = await readFile(path, "utf-8")
          const lines = content.split("\n")
          return lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join("\n")
        },
        writeFile: async (path: string, content: string): Promise<string> => {
          await writeFile(path, content, "utf-8")
          return `Written: ${path}`
        },
        appendFile: async (path: string, content: string): Promise<string> => {
          await appendFile(path, content, "utf-8")
          return `Appended to: ${path}`
        },
        grep: async (pattern: string, path: string): Promise<string> => {
          try {
            const { stdout } = await execFileAsync("grep", ["-rn", pattern, path], { timeout: 10_000 })
              .catch((e: { stdout?: string; code?: number }) => e.code === 1 ? { stdout: "" } : Promise.reject(e))
            const lines = (stdout as string).trim().split("\n").slice(0, 150)
            return lines.join("\n") || "(no matches)"
          } catch { return "(error)" }
        },
        glob: async (pattern: string, cwd?: string): Promise<string> => {
          const matches: string[] = []
          for await (const f of fsGlob(pattern, { cwd: cwd ?? "." })) matches.push(f)
          return matches.sort().join("\n") || "(no matches)"
        },
        bash: async (command: string): Promise<string> => {
          return new Promise((resolve) => {
            const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] })
            let out = ""
            child.stdout?.on("data", (d) => { out += d.toString() })
            child.stderr?.on("data", (d) => { out += d.toString() })
            child.on("close", () => resolve(out.length > 10_000 ? out.slice(0, 10_000) + "\n[truncated]" : out))
          })
        },
      }

      // Build and execute the sandboxed async function
      const fn = new AsyncFunction(
        "tools", "console",
        `const { readFile, readLines, writeFile, appendFile, grep, glob, bash } = tools;\n${code}`
      )

      try {
        await fn(toolkit, fakeConsole)
      } catch (e) {
        output.push(`[runtime error] ${e instanceof Error ? e.message : String(e)}`)
      }

      return { id, content: output.join("\n") || "(no output — use console.log to return results)" }
    },
    catch: (e) => new ToolError("execute_code", e),
  })

// Mode switch — agent signals intent to change execution mode.
// Sets GATES_ACTIVE_MODE env var; Runner injects updated system prompt on next round.
const VALID_MODES = ["ProRN", "LEARN", "PATCH", "STANDARD", "REFACTOR"] as const
const mode_switch: ToolHandler = (id, input) =>
  Effect.tryPromise({
    try: async () => {
      const { mode, reason } = input as { mode: string; reason?: string }
      if (!VALID_MODES.includes(mode as (typeof VALID_MODES)[number])) {
        return { id, content: `Invalid mode "${mode}". Valid modes: ${VALID_MODES.join(", ")}` }
      }
      process.env["GATES_ACTIVE_MODE"] = mode
      const msg = reason ? `Mode switched to ${mode}: ${reason}` : `Mode switched to ${mode}`
      console.error(`[mode_switch] ${msg}`)
      return { id, content: msg }
    },
    catch: (e) => new ToolError("mode_switch", e),
  })

const handlers = new Map<string, ToolHandler>([
  ["bash", bash],
  ["read", read],
  ["write", write],
  ["edit", edit],
  ["glob", glob],
  ["grep", grep],
  ["fetch", fetch_url],
  ["read_lines", read_lines],
  ["write_lines", write_lines],
  ["gh_issue_read", gh_issue_read],
  ["gh_issue_list", gh_issue_list],
  ["gh_issue_create", gh_issue_create],
  ["gh_pr_create", gh_pr_create],
  ["mode_switch", mode_switch],
  ["execute_code", execute_code],
])

const definitions: ToolDef[] = [
  {
    name: "execute_code",
    description: `PRIMARY TOOL — Use this first for any task involving reading files, grepping, or chaining operations. It runs all operations in ONE round instead of many, keeping the context window small.

Available async functions:
  readFile(path)              — read full file content
  readLines(path, start, end) — read specific line range
  writeFile(path, content)    — write a file
  appendFile(path, content)   — append to a file
  grep(pattern, path)         — search for pattern
  glob(pattern, cwd?)         — list matching files
  bash(command)               — run shell command

Use console.log() to return results:
  const src = await readLines("src/cli/args.ts", 1, 50)
  const pkg = JSON.parse(await readFile("package.json"))
  console.log(JSON.stringify({ src, version: pkg.version }))

Only fall back to individual tools (read, grep, bash) when you need a gate-enforced single operation.`,
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Async JavaScript. Use console.log() to return results." },
      },
      required: ["code"],
    },
  },
  {
    name: "bash",
    description: "Run a shell command. Prefer execute_code for multi-step operations.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number", description: "Timeout in milliseconds. Defaults to 30000." },
      },
      required: ["command"],
    },
  },
  {
    name: "read",
    description: "Read a file. Prefer execute_code when reading multiple files.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Write a new file (or fully overwrite). Prefer edit for existing files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description: "Replace the first (and only) occurrence of old_string with new_string in a file. Fails if old_string is not found or appears more than once.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "glob",
    description: "List files matching a glob pattern. Returns a sorted newline-separated list of matching paths, or '(no matches)' if none found.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, e.g. 'src/**/*.ts' or '**/*.json'",
        },
        cwd: {
          type: "string",
          description: "Directory to search from. Defaults to '.' (current working directory).",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "SLOW — adds a full round-trip to history (O(N) cost). Only use when calling grep ONCE in isolation. For multiple searches or any combination with readLines/readFile, use execute_code instead: execute_code(`const r = await grep('pattern', 'path'); console.log(r)`).",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex or string to search for" },
        path: { type: "string", description: "File or directory to search in" },
        case_sensitive: { type: "boolean", description: "Case sensitive search. Defaults to true." },
      },
      required: ["pattern", "path"],
    },
  },
  {
    name: "fetch",
    description: "Make an HTTP request. Returns the status code and response body (truncated at 20k chars).",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        method: { type: "string", description: "HTTP method. Defaults to GET." },
        body: { type: "string", description: "Request body (for POST/PUT)" },
        headers: {
          type: "object",
          description: "Additional request headers",
          additionalProperties: { type: "string" },
        },
      },
      required: ["url"],
    },
  },
  {
    name: "read_lines",
    description: "SLOW when called repeatedly — each call adds a round-trip to history. Prefer execute_code for any multi-step reading: execute_code(`const c = await readLines('file', 1, 80); console.log(c)`). Use read_lines only when reading exactly one range in isolation.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start: { type: "number", description: "1-based inclusive start line" },
        end: { type: "number", description: "1-based inclusive end line" },
      },
      required: ["path", "start", "end"],
    },
  },
  {
    name: "write_lines",
    description:
      "Appends lines to a file. Creates the file if it does not exist. Use `ensure_newline` to guarantee the existing content ends with a newline before appending.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        lines: {
          type: "array",
          items: { type: "string" },
          description: "Lines to append to the file",
        },
        ensure_newline: {
          type: "boolean",
          description:
            "If true, guarantees the file already ends with a newline before appending. Defaults to false.",
        },
      },
      required: ["path", "lines"],
    },
  },
  {
    name: "gh_issue_read",
    description: "Read a GitHub issue by number. Returns title, body, labels, state, and URL as JSON.",
    input_schema: {
      type: "object",
      properties: { number: { type: "number", description: "Issue number" } },
      required: ["number"],
    },
  },
  {
    name: "gh_issue_list",
    description: "List open GitHub issues (up to 20). Returns JSON array with number, title, state, labels.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "gh_issue_create",
    description: "Create a GitHub issue. Returns the URL of the created issue.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "Markdown body of the issue" },
        labels: { type: "array", items: { type: "string" }, description: "Optional labels" },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "gh_pr_create",
    description: "Create a GitHub PR from the current branch. Returns the PR URL.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "Markdown body of the PR" },
        base: { type: "string", description: "Base branch. Defaults to main." },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "mode_switch",
    description: "Switch the active execution mode when the current approach is not working. Call when stuck in reading loops, when a task is simpler/harder than expected, or when the context changes. The Runner will inject the new mode's system prompt on the next round.",
    input_schema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["ProRN", "LEARN", "PATCH", "STANDARD", "REFACTOR"],
          description: "ProRN: read-only Q&A | LEARN: docs only | PATCH: targeted minimal edit | STANDARD: full lifecycle | REFACTOR: decompose large files",
        },
        reason: {
          type: "string",
          description: "Why you are switching modes. Helps the next round understand the context shift.",
        },
      },
      required: ["mode"],
    },
  },
]

const makeImpl: Effect.Effect<ToolRegistryShape> = Effect.sync(() => ({
  execute: (id, name, input) => {
    const handler = handlers.get(name)
    if (!handler) {
      return Effect.fail(new ToolError(name, `Unknown tool: ${name}`))
    }
    return handler(id, input)
  },
  definitions,
}))

export const ToolRegistryLayer = Layer.effect(ToolRegistry)(makeImpl)
