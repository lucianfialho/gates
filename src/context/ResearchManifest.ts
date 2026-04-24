/**
 * Research Manifest — deterministic pre-pass (zero LLM tokens)
 *
 * Inspired by Karpathy's autoresearch pattern:
 * instead of the agent reading files freely, we pre-scope what it can read.
 * Like `grep "^val_bpb:" run.log` instead of loading the full log.
 *
 * The manifest is built from .metadata/summary.yaml files (already indexed)
 * using the same keyword scoring as the research state, but without any LLM.
 * The result caps what files the agent reads — structural enforcement, not prompt.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { load, dump } from "js-yaml"
import { loadGatesConfig } from "../config/GatesConfig.js"

export interface ManifestEntry {
  file: string
  relevance: string
  score: number
}

export interface ResearchManifest {
  task: string
  manifest: ManifestEntry[]
  allowed_files: string[]  // flat list for gate lookups
  built_at: string
  token_cost: 0  // always 0 — this is the point
}

const MANIFEST_PATH = join(process.cwd(), ".gates", "research-manifest.yaml")
const MAX_MANIFEST_ENTRIES = 20
const MIN_SCORE_THRESHOLD = 1

// Score a file path against the issue keywords
const scoreFile = (filePath: string, issue: string): number => {
  const issueWords = issue.toLowerCase().split(/\W+/).filter(w => w.length > 3)
  const fileWords = filePath.toLowerCase()
  let score = 0
  for (const word of issueWords) {
    if (fileWords.includes(word)) score += 3  // direct path match
  }
  // Bonus for explicit file path mentions in issue text
  if (issue.toLowerCase().includes(filePath.toLowerCase())) score += 10
  return score
}

// Score a directory summary against the issue keywords
const scoreDir = (covers: string[], title: string | null, specialist: string | null, issue: string): number => {
  const issueWords = issue.toLowerCase().split(/\W+/).filter(w => w.length > 3)
  const dirText = [title ?? "", specialist ?? "", ...covers].join(" ").toLowerCase()
  let score = 0
  for (const word of issueWords) {
    if (dirText.includes(word)) score += 2
  }
  return score
}

// Build a relevance reason string from matching keywords
const buildRelevanceReason = (filePath: string, issue: string): string => {
  const issueWords = issue.toLowerCase().split(/\W+/).filter(w => w.length > 3)
  const fileWords = filePath.toLowerCase()
  const matched = issueWords.filter(w => fileWords.includes(w))
  if (matched.length > 0) return `matches keywords: ${matched.slice(0, 3).join(", ")}`
  return "in relevant directory"
}

/**
 * Build the research manifest — zero LLM tokens.
 * Reads .metadata/summary.yaml for all indexed directories,
 * scores files against the issue keywords, returns top-N entries.
 */
export const buildResearchManifest = async (issue: string): Promise<ResearchManifest> => {
  const config = await loadGatesConfig()
  const dirs = config.indexed_directories ?? []

  const entries: ManifestEntry[] = []

  for (const dir of dirs) {
    try {
      const summaryPath = join(process.cwd(), dir.path, ".metadata", "summary.yaml")
      const raw = await readFile(summaryPath, "utf-8")
      const summary = load(raw) as {
        covers?: string[]
        title?: string
        specialist?: string
      }

      const covers = summary.covers ?? []
      const dirScore = scoreDir(covers, summary.title ?? null, summary.specialist ?? null, issue)

      if (dirScore === 0) continue  // directory not relevant, skip all its files

      for (const filePath of covers) {
        const fileScore = dirScore + scoreFile(filePath, issue)
        if (fileScore < MIN_SCORE_THRESHOLD) continue

        entries.push({
          file: filePath,
          relevance: buildRelevanceReason(filePath, issue),
          score: fileScore,
        })
      }
    } catch {
      // no .metadata/summary.yaml — skip
    }
  }

  // Sort by score descending, cap at MAX_MANIFEST_ENTRIES
  const sorted = entries
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MANIFEST_ENTRIES)

  const manifest: ResearchManifest = {
    task: issue.slice(0, 200),
    manifest: sorted,
    allowed_files: sorted.map(e => e.file),
    built_at: new Date().toISOString(),
    token_cost: 0,
  }

  // Persist to .gates/research-manifest.yaml for gate lookups
  await mkdir(join(process.cwd(), ".gates"), { recursive: true })
  await writeFile(MANIFEST_PATH, dump(manifest), "utf-8")

  return manifest
}

/** Load the current manifest (if any) — used by the gate */
export const loadCurrentManifest = async (): Promise<ResearchManifest | null> => {
  try {
    const raw = await readFile(MANIFEST_PATH, "utf-8")
    return load(raw) as ResearchManifest
  } catch {
    return null
  }
}

/** Clear the manifest after use */
export const clearManifest = async (): Promise<void> => {
  try {
    const { unlink } = await import("node:fs/promises")
    await unlink(MANIFEST_PATH)
  } catch { /* already gone */ }
}

/** Format manifest for injection into research context */
export const formatManifestContext = (manifest: ResearchManifest): string => {
  if (!manifest.manifest.length) return ""
  const lines = [
    `\n=== Research manifest (zero LLM tokens — autoresearch pattern) ===`,
    `Task: ${manifest.task}`,
    `Files pre-scoped from .metadata/ (read ONLY these files — do not read outside this list):`,
  ]
  for (const entry of manifest.manifest) {
    lines.push(`  [score=${entry.score}] ${entry.file}  — ${entry.relevance}`)
  }
  lines.push(`\nDo NOT call read() on files outside this manifest. Use execute_code with the files above.`)
  return lines.join("\n")
}
