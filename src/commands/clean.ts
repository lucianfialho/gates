#!/usr/bin/env bun
import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"

const DEFAULT_KEEP = 20

export const runClean = async (keepArg?: string) => {
  const runsDir = join(process.cwd(), ".gates", "runs")

  // Parse --keep argument
  let keep: number
  if (keepArg !== undefined) {
    const parsed = parseInt(keepArg, 10)
    if (isNaN(parsed) || parsed < 0) {
      console.error(`Error: --keep must be a non-negative integer, got: ${keepArg}`)
      process.exit(1)
    }
    keep = parsed
  } else {
    keep = DEFAULT_KEEP
  }

  // Get all .jsonl files sorted by name (which is uuid, so effectively random)
  // We'll sort by file modification time for "most recent" logic
  let files: string[]
  try {
    files = (await readdir(runsDir)).filter((f) => f.endsWith(".jsonl"))
  } catch {
    console.error("No runs directory found. Run a command first.")
    return
  }

  if (files.length === 0) {
    console.log("No run files to clean.")
    return
  }

  // Sort by modification time, newest first
  const fs = await import("node:fs/promises")
  const fileInfos = await Promise.all(
    files.map(async (f) => {
      const stat = await fs.stat(join(runsDir, f))
      return { name: f, mtime: stat.mtimeMs }
    })
  )
  fileInfos.sort((a, b) => b.mtime - a.mtime)

  // Files to keep
  const toKeep = fileInfos.slice(0, keep)
  const toDelete = fileInfos.slice(keep)

  if (toDelete.length === 0) {
    console.log(`No files to remove. ${files.length} file(s) kept.`)
    return
  }

  // Delete the old files
  for (const { name } of toDelete) {
    await rm(join(runsDir, name))
  }

  console.log(`Removed ${toDelete.length} file(s). Kept ${toKeep.length} most recent.`)
}
