import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { load } from "js-yaml"
import { loadGatesConfig, type IndexedDirectory } from "../config/GatesConfig.js"

const execFileAsync = promisify(execFile)

// ── types ────────────────────────────────────────────────────────────────────

export interface MetadataSummary {
  dir: string
  id: string | null
  title: string | null
  covers: string[]
  specialist: string | null
  last_updated: string | null
}

export interface RelatedIssue {
  number: number
  title: string
  state: "open" | "closed"
  body?: string
}

export interface ResearchContext {
  summaries: MetadataSummary[]
  related: RelatedIssue[]
  built_at: string
}

// ── loaders ──────────────────────────────────────────────────────────────────

const readMetadataSummary = (dir: string): Effect.Effect<MetadataSummary | null> =>
  Effect.promise(async () => {
    try {
      const path = join(process.cwd(), dir, ".metadata", "summary.yaml")
      const raw = await readFile(path, "utf-8")
      const data = load(raw) as Record<string, unknown>
      return {
        dir,
        id:           typeof data["id"] === "string" ? data["id"] : null,
        title:        typeof data["title"] === "string" ? data["title"] : null,
        covers:       Array.isArray(data["covers"]) ? data["covers"] as string[] : [],
        specialist:   typeof data["specialist"] === "string" ? data["specialist"] : null,
        last_updated: typeof data["last_updated"] === "string" ? data["last_updated"] : null,
      }
    } catch {
      return null
    }
  })

const searchRelatedIssues = (query: string): Effect.Effect<RelatedIssue[]> =>
  Effect.promise(async () => {
    try {
      // Extract keywords (first 4 words, skip issue numbers)
      const keywords = query
        .replace(/^\d+$/, "")
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 4)
        .join(" ")

      if (!keywords) return []

      const { stdout } = await execFileAsync(
        "gh",
        ["issue", "list", "--search", keywords, "--state", "all",
         "--json", "number,title,state,body", "--limit", "5"],
        { cwd: process.cwd(), timeout: 10_000 }
      )
      const issues = JSON.parse(stdout) as Array<{
        number: number; title: string; state: string; body: string
      }>
      return issues.map(i => ({
        number: i.number,
        title:  i.title,
        state:  i.state === "CLOSED" ? "closed" : "open",
        body:   i.body?.slice(0, 300),
      }))
    } catch {
      return []
    }
  })

// ── main builder ─────────────────────────────────────────────────────────────

export const buildResearchContext = (issue: string): Effect.Effect<ResearchContext> =>
  Effect.gen(function* () {
    const config = yield* Effect.promise(() => loadGatesConfig())
    const dirs: IndexedDirectory[] = config.indexed_directories ?? []

    // Read all .metadata/summary.yaml in parallel — zero tokens
    const rawSummaries = yield* Effect.forEach(
      dirs,
      (d) => readMetadataSummary(d.path),
      { concurrency: "unbounded" }
    )
    const summaries = rawSummaries.filter((s): s is MetadataSummary => s !== null)

    // Search GitHub for related issues in parallel with metadata load
    const related = yield* searchRelatedIssues(issue)

    return { summaries, related, built_at: new Date().toISOString() }
  })

// ── prompt formatter ──────────────────────────────────────────────────────────

export const formatResearchContext = (ctx: ResearchContext): string => {
  const lines: string[] = ["=== Project metadata (pre-loaded) ==="]

  for (const s of ctx.summaries) {
    lines.push(`\n${s.dir}/`)
    if (s.title)   lines.push(`  title: ${s.title}`)
    if (s.covers?.length) lines.push(`  covers: ${s.covers.join(", ")}`)
    if (s.specialist) lines.push(`  specialist: ${s.specialist}`)
  }

  if (ctx.related.length > 0) {
    lines.push("\n=== Related issues (pre-fetched from GitHub) ===")
    for (const r of ctx.related) {
      lines.push(`\n#${r.number} [${r.state}] ${r.title}`)
      if (r.body) lines.push(`  context: ${r.body.replace(/\n/g, " ").slice(0, 200)}`)
    }
  }

  return lines.join("\n")
}
