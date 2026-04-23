import { Context, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { glob as fsGlob } from "node:fs/promises"
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
  id: string
  content: string
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
      const { command, timeout = 30_000 } = input as { command: string; timeout?: number }
      const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
        timeout,
      })
      return { id, content: stdout + (stderr ? `\nSTDERR: ${stderr}` : "") }
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
])

const definitions: ToolDef[] = [
  {
    name: "bash",
    description: "Run a shell command",
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
    description: "Read a file",
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
    description: "Search for a pattern in files using grep. Returns matching lines with file path and line number.",
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
    description: "Read a specific line range from a file. Cheaper than reading the whole file.",
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
