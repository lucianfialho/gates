import { readFile, writeFile, mkdir } from "node:fs/promises"
import { glob } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { dump, load } from "js-yaml"

const execFileAsync = promisify(execFile)

const CONTEXT_FILE    = join(process.cwd(), ".gates", "context.yaml")
const RELEVANT_FILE   = join(process.cwd(), ".gates", "relevant.json")
const MAX_FILES = 80
const EXPORT_RE = /export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|interface|type|enum)\s+(\w+)/g

interface FileEntry {
  lines: number
  exports: string[]
}

export interface ProjectContext {
  updated_at: string
  files: Record<string, FileEntry>
  recent_changes: string[]
  relevantPaths: string[]
  phase: "analyze" | "implement" | "verify"
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
      files[f] = { lines: src.split("\n").length, exports: extractExports(src) }
    } catch { /* skip unreadable */ }
  }

  let recent_changes: string[] = []
  try {
    const { stdout } = await execFileAsync("git", ["log", "--oneline", "-6"], { cwd: process.cwd() })
    recent_changes = stdout.trim().split("\n").filter(Boolean)
  } catch { /* not a git repo */ }

  let relevantPaths: string[] = []
  try {
    const raw = await readFile(RELEVANT_FILE, "utf-8")
    relevantPaths = JSON.parse(raw) as string[]
  } catch { /* file not found or unparseable */ }

  return { updated_at: new Date().toISOString(), files, recent_changes, relevantPaths, phase: "analyze" }
}

export const updateContextFile = async (): Promise<void> => {
  try {
    await mkdir(join(process.cwd(), ".gates"), { recursive: true })
    const ctx = await scanProject()
    await writeFile(CONTEXT_FILE, dump(ctx, { lineWidth: 120 }))
  } catch { /* best-effort */ }
}

const MAX_CONTEXT_CHARS = 12_000  // ~3k tokens — matches claw-code's 12K budget
const MAX_FILE_ENTRY_CHARS = 120   // one line per file max

export const buildContextPrompt = async (filterFiles?: string[]): Promise<string | null> => {
  try {
    const raw = await readFile(CONTEXT_FILE, "utf-8")
    const ctx = load(raw) as ProjectContext

    const allFiles = Object.entries(ctx.files)
    const relevant = filterFiles?.length
      ? allFiles.filter(([path]) => filterFiles.some((f) => path.includes(f) || f.includes(path)))
      : allFiles

    const fileLines = relevant
      .map(([path, { lines, exports }]) => {
        const entry = `  ${path} (${lines} lines)${exports.length ? ` — exports: ${exports.slice(0, 4).join(", ")}` : ""}`
        return entry.slice(0, MAX_FILE_ENTRY_CHARS)
      })
      .join("\n")

    const changes = ctx.recent_changes.slice(0, 5).map((c) => `  ${c}`).join("\n")

    const result = [
      `## Project snapshot (${ctx.updated_at.slice(0, 10)})`,
      `Files:\n${fileLines}`,
      changes ? `Recent commits:\n${changes}` : "",
    ].filter(Boolean).join("\n\n")

    // Hard cap — truncate with notice rather than silently blow up context
    if (result.length > MAX_CONTEXT_CHARS) {
      return result.slice(0, MAX_CONTEXT_CHARS) + `\n… [truncated at ${MAX_CONTEXT_CHARS} chars]`
    }
    return result
  } catch {
    return null
  }
}
