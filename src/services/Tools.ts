import { Context, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
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

const handlers = new Map<string, ToolHandler>([
  ["bash", bash],
  ["read", read],
  ["write", write],
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
    description: "Write a file",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
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
