/**
 * Analyze Fragment — zero LLM tokens, same pattern as ResearchManifest.
 *
 * After research identifies likely_files, extract structural information
 * (exports, function signatures, line count) from each file deterministically.
 * Inject as context before analyze runs — agent produces PRP without reading files.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface FileFragment {
  file: string
  lines: number
  exports: string[]
  functions: string[]
  note?: string
}

export interface AnalyzeFragments {
  files: FileFragment[]
  built_at: string
  token_cost: 0
}

const MAX_ITEMS = 8  // max exports/functions per file
const MAX_FILES = 6  // max files to fragment

const extractExports = (content: string): string[] => {
  const matches = content.match(/export\s+(?:const|function|class|async function|default function|interface|type|enum)\s+(\w+)/g) ?? []
  return [...new Set(matches
    .map(m => /(\w+)\s*$/.exec(m)?.[1] ?? "")
    .filter(Boolean)
  )].slice(0, MAX_ITEMS)
}

const extractFunctions = (content: string): string[] => {
  const results: string[] = []
  // const name = (...): returnType =>
  const arrowFns = content.match(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)/g) ?? []
  // function name(...) and async function name(...)
  const namedFns = content.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/g) ?? []

  for (const match of [...arrowFns, ...namedFns].slice(0, MAX_ITEMS)) {
    const name = match.replace(/(?:export\s+)?(?:async\s+)?(?:const\s+|function\s+)/, "").split(/\s*[=(]/)[0]?.trim()
    if (name && name.length > 1) results.push(name)
  }
  return [...new Set(results)].slice(0, MAX_ITEMS)
}

const buildFragment = async (filePath: string, cwd = process.cwd()): Promise<FileFragment | null> => {
  try {
    const abs = join(cwd, filePath)
    const content = await readFile(abs, "utf-8")
    const lines = content.split("\n").length
    return {
      file: filePath,
      lines,
      exports: extractExports(content),
      functions: extractFunctions(content),
    }
  } catch {
    return null
  }
}

export const buildAnalyzeFragments = async (likelyFiles: string[]): Promise<AnalyzeFragments> => {
  const fragments = await Promise.all(
    likelyFiles.slice(0, MAX_FILES).map(f => buildFragment(f))
  )
  return {
    files: fragments.filter((f): f is FileFragment => f !== null),
    built_at: new Date().toISOString(),
    token_cost: 0,
  }
}

export const formatAnalyzeFragments = (frags: AnalyzeFragments): string => {
  if (!frags.files.length) return ""
  const lines = [
    "\n=== File fragments for analyze (zero LLM tokens) ===",
    "Use this structural overview — do NOT call read() or execute_code to re-read these files unless you need a specific body section.",
  ]
  for (const f of frags.files) {
    lines.push(`\n${f.file} (${f.lines} lines)`)
    if (f.exports.length) lines.push(`  exports: ${f.exports.join(", ")}`)
    if (f.functions.length) lines.push(`  functions: ${f.functions.join(", ")}`)
  }
  return lines.join("\n")
}
