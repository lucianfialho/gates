import { readFile, writeFile, mkdir } from "node:fs/promises"
import { glob } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { dump, load } from "js-yaml"

const execFileAsync = promisify(execFile)

const CONTEXT_FILE = join(process.cwd(), ".gates", "context.yaml")
const MAX_FILES = 80
const EXPORT_RE = /export\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|interface|type|enum)\s+(\w+)/g

interface FileEntry {
  lines: number
  exports: string[]
}

interface ProjectContext {
  updated_at: string
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
      files[f] = { lines: src.split("\n").length, exports: extractExports(src) }
    } catch { /* skip unreadable */ }
  }

  let recent_changes: string[] = []
  try {
    const { stdout } = await execFileAsync("git", ["log", "--oneline", "-6"], { cwd: process.cwd() })
    recent_changes = stdout.trim().split("\n").filter(Boolean)
  } catch { /* not a git repo */ }

  return { updated_at: new Date().toISOString(), files, recent_changes }
}

export const updateContextFile = async (): Promise<void> => {
  try {
    await mkdir(join(process.cwd(), ".gates"), { recursive: true })
    const ctx = await scanProject()
    await writeFile(CONTEXT_FILE, dump(ctx, { lineWidth: 120 }))
  } catch { /* best-effort */ }
}

export const buildContextPrompt = async (filterFiles?: string[]): Promise<string | null> => {
  try {
    const raw = await readFile(CONTEXT_FILE, "utf-8")
    const ctx = load(raw) as ProjectContext

    const allFiles = Object.entries(ctx.files)
    const relevant = filterFiles?.length
      ? allFiles.filter(([path]) => filterFiles.some((f) => path.includes(f) || f.includes(path)))
      : allFiles

    const fileLines = relevant
      .map(([path, { lines, exports }]) =>
        `  ${path} (${lines} lines)${exports.length ? ` — exports: ${exports.slice(0, 6).join(", ")}` : ""}`
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
