import { Context, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
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
      const { command } = input as { command: string }
      const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
        timeout: 30_000,
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
      return {
        id,
        content: stdout.trim() || "(no matches)",
      }
    },
    catch: (e) => new ToolError("grep", e),
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

const handlers = new Map<string, ToolHandler>([
  ["bash", bash],
  ["read", read],
  ["write", write],
  ["edit", edit],
  ["glob", glob],
  ["grep", grep],
  ["fetch", fetch_url],
])

const definitions: ToolDef[] = [
  {
    name: "bash",
    description: "Run a shell command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
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
