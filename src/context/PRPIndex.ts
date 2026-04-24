import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

export interface PRPEntry {
  id: string
  title: string
  root_cause: string
  files: string[]
  keywords: string[]
  solution_summary: string
  complexity: string
  path: string
}

// Extract keywords from issue title + root_cause for scoring
const extractKeywords = (text: string): string[] =>
  text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3)

const scoreRelevance = (entry: PRPEntry, issue: string): number => {
  const issueWords = extractKeywords(issue)
  const entryText = [entry.title, entry.root_cause, entry.solution_summary, ...entry.keywords].join(" ").toLowerCase()
  return issueWords.reduce((score, word) => score + (entryText.includes(word) ? 2 : 0), 0)
}

// Parse PRP markdown (JSON frontmatter in ```json block)
const parsePRP = (content: string, path: string): PRPEntry | null => {
  try {
    const jsonMatch = /```json\s*([\s\S]+?)\s*```/.exec(content)
    if (!jsonMatch) return null
    const prp = JSON.parse(jsonMatch[1]!) as Record<string, unknown>
    const spec = prp["spec"] as Record<string, unknown> | undefined
    const ctx = prp["context"] as Record<string, unknown> | undefined
    const changes = spec?.["changes"] as Array<Record<string, unknown>> | undefined

    return {
      id: String(prp["id"] ?? ""),
      title: String(prp["issue_title"] ?? prp["id"] ?? ""),
      root_cause: String(spec?.["root_cause"] ?? ""),
      files: Array.isArray(ctx?.["files"]) ? ctx["files"] as string[] : [],
      keywords: extractKeywords(String(prp["issue_title"] ?? "") + " " + String(spec?.["root_cause"] ?? "")),
      solution_summary: changes?.map(c => `${c["file"]}: ${c["description"]}`).join("; ") ?? "",
      complexity: String(prp["complexity"] ?? ""),
      path,
    }
  } catch {
    return null
  }
}

// Load all PRPs from .prp/ directory
export const loadPRPIndex = async (cwd = process.cwd()): Promise<PRPEntry[]> => {
  try {
    const prpDir = join(cwd, ".prp")
    const files = (await readdir(prpDir).catch(() => [])).filter(f => f.endsWith(".md"))
    const entries = await Promise.all(
      files.map(async f => {
        const content = await readFile(join(prpDir, f), "utf-8").catch(() => "")
        return parsePRP(content, join(".prp", f))
      })
    )
    return entries.filter((e): e is PRPEntry => e !== null)
  } catch {
    return []
  }
}

// Find relevant PRPs for a given issue — MemCoder-style memory retrieval
export const findRelevantPRPs = async (issue: string, maxResults = 3): Promise<PRPEntry[]> => {
  const all = await loadPRPIndex()
  return all
    .map(e => ({ e, score: scoreRelevance(e, issue) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ e }) => e)
}

// Format PRPs for injection into research context
export const formatPRPContext = (prps: PRPEntry[]): string => {
  if (!prps.length) return ""
  const lines = ["\n=== Related patterns from project history (MemCoder memory) ==="]
  for (const p of prps) {
    lines.push(`\n[${p.id}] ${p.title} (${p.complexity})`)
    lines.push(`  root_cause: ${p.root_cause.slice(0, 150)}`)
    lines.push(`  files: ${p.files.slice(0, 4).join(", ")}`)
    if (p.solution_summary) lines.push(`  solution: ${p.solution_summary.slice(0, 150)}`)
  }
  return lines.join("\n")
}
