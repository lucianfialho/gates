import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { load } from "js-yaml"
import { loadGatesConfig, type IndexedDirectory } from "../config/GatesConfig.js"
import { findRelevantPRPs, formatPRPContext } from "./PRPIndex.js"

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
  prpMatches: import("./PRPIndex.js").PRPEntry[]
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

// ── Knowledge Architect: relevance scoring ────────────────────────────────────

const scoreRelevance = (summary: MetadataSummary, issue: string): number => {
  const issueWords = issue.toLowerCase().split(/\W+/).filter(w => w.length > 3)
  const fields = [
    summary.title ?? "",
    summary.specialist ?? "",
    ...(summary.covers ?? []),
  ].join(" ").toLowerCase()

  let score = 0
  for (const word of issueWords) {
    if (fields.includes(word)) score += 2
  }
  // Bonus for explicit file path matches in the issue text
  const filePattern = /(?:src|skills)\/[\w/.-]+\.(?:ts|tsx|yaml)/g
  const issueFiles = issue.match(filePattern) ?? []
  for (const f of issueFiles) {
    if ((summary.covers ?? []).some(c => c.includes(f) || f.includes(c))) score += 10
  }
  return score
}

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
    const allSummaries = rawSummaries.filter((s): s is MetadataSummary => s !== null)

    // Knowledge Architect: rank by relevance, inject only top-N (not all 7)
    const scored = allSummaries
      .map(s => ({ s, score: scoreRelevance(s, issue) }))
      .sort((a, b) => b.score - a.score)
    const summaries = scored.filter((x, i) => i < 3 || x.score > 0).map(x => x.s)

    // Search GitHub for related issues in parallel
    // Also load PRPs from .prp/ — MemCoder-style memory retrieval (zero LLM tokens)
    const [related, prpMatches] = yield* Effect.all([
      searchRelatedIssues(issue),
      Effect.promise(() => findRelevantPRPs(issue)),
    ])

    return { summaries, related, prpMatches, built_at: new Date().toISOString() }
  })

// ── prompt formatter ──────────────────────────────────────────────────────────

const MAX_RESEARCH_DIRS = 5       // top-N relevant dirs only
const MAX_COVERS = 4              // covers per dir
const MAX_ISSUE_BODY = 120        // chars per related issue body
const MAX_RELATED_ISSUES = 3      // related issues max

export const formatResearchContext = (ctx: ResearchContext): string => {
  const lines: string[] = ["=== Project metadata (ranked by relevance) ==="]

  for (const s of ctx.summaries.slice(0, MAX_RESEARCH_DIRS)) {
    lines.push(`\n${s.dir}/`)
    if (s.title)   lines.push(`  title: ${s.title}`)
    if (s.covers?.length) lines.push(`  covers: ${s.covers.slice(0, MAX_COVERS).join(", ")}`)
    if (s.specialist) lines.push(`  specialist: ${s.specialist}`)
  }

  if (ctx.related.length > 0) {
    lines.push("\n=== Related issues ===")
    for (const r of ctx.related.slice(0, MAX_RELATED_ISSUES)) {
      lines.push(`#${r.number} [${r.state}] ${r.title}`)
      if (r.body) lines.push(`  ${r.body.replace(/\n/g, " ").slice(0, MAX_ISSUE_BODY)}`)
    }
  }

  // MemCoder memory: inject relevant PRPs before agent reads any files
  if (ctx.prpMatches?.length > 0) {
    lines.push(formatPRPContext(ctx.prpMatches))
  }

  return lines.join("\n")
}
