import { readFile, writeFile, mkdir } from "node:fs/promises"
import { glob } from "node:fs/promises"
import { join, relative } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const CONTEXT_FILE = join(process.cwd(), ".gates", "context.json")
const MAX_FILES = 80
const EXPORT_RE = /export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|interface|type|enum)\s+(\w+)/g

interface FileEntry {
  lines: number
  exports: string[]
}

interface ProjectContext {
  updated_at: string
  cwd: string
  files: Record<string, FileEntry>
  recent_changes: string[]
}

const extractExports = (src: string): string[] => {
  const names: string[] = []
  let m: RegExpExecArray | null
  EXPORT_RE.lastIndex = 0
  while ((m = EXPORT_RE.exec(src)) !== null) {
    if (m[1]) names.push(m[1])
  }
  return names
}

export const scanProject = async (): Promise<ProjectContext> => {
  const files: Record<string, FileEntry> = {}
  let count = 0

  for await (const f of glob("src/**/*.ts", { cwd: process.cwd() })) {
    if (count++ >= MAX_FILES) break
    try {
      const src = await readFile(join(process.cwd(), f), "utf-8")
      const lines = src.split("\n").length
      files[f] = { lines, exports: extractExports(src) }
    } catch { /* skip unreadable */ }
  }

  let recent_changes: string[] = []
  try {
    const { stdout } = await execFileAsync("git", ["log", "--oneline", "-8"], { cwd: process.cwd() })
    recent_changes = stdout.trim().split("\n").filter(Boolean)
  } catch { /* not a git repo or no commits */ }

  return {
    updated_at: new Date().toISOString(),
    cwd: process.cwd(),
    files,
    recent_changes,
  }
}

export const updateContextFile = async (): Promise<void> => {
  try {
    await mkdir(join(process.cwd(), ".gates"), { recursive: true })
    const ctx = await scanProject()
    await writeFile(CONTEXT_FILE, JSON.stringify(ctx, null, 2))
  } catch { /* best-effort */ }
}

export const buildContextPrompt = async (): Promise<string | null> => {
  try {
    const raw = await readFile(CONTEXT_FILE, "utf-8")
    const ctx = JSON.parse(raw) as ProjectContext

    const fileLines = Object.entries(ctx.files)
      .map(([path, { lines, exports }]) =>
        `  ${path} (${lines} lines)${exports.length ? ` — exports: ${exports.join(", ")}` : ""}`
      )
      .join("\n")

    const changes = ctx.recent_changes.map((c) => `  ${c}`).join("\n")

    return [
      `## Project snapshot (${ctx.updated_at.slice(0, 10)})`,
      `Files:\n${fileLines}`,
      changes ? `Recent commits:\n${changes}` : "",
    ].filter(Boolean).join("\n\n")
  } catch {
    return null
  }
}
