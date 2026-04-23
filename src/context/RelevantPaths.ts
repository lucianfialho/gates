import { writeFile } from "node:fs/promises"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// RelevantPathsStore
// ---------------------------------------------------------------------------

const RELEVANT_FILE = join(process.cwd(), ".gates", "relevant.json")

/**
 * Writes the array of relevant file paths emitted by the **analyze** step
 * into `.gates/relevant.json`.  The file is created / overwritten on every
 * analyze completion so that subsequent steps can scope context to only those
 * files.
 *
 * Schema reference (skills/solve-issue/schemas/analyze.output.schema.json):
 *   { files: string[], plan: string[], ... }
 *
 * The `files` field is the canonical source of truth for "what the model
 * deemed relevant during analysis".
 */
export const writeRelevantPaths = async (analyzeOutput: unknown): Promise<void> => {
  let files: string[] = []

  // Try to extract the `files` field from a plain object
  if (analyzeOutput !== null && typeof analyzeOutput === "object") {
    const obj = analyzeOutput as Record<string, unknown>
    if (Array.isArray(obj["files"])) {
      files = obj["files"] as string[]
    }
  }

  await writeFile(RELEVANT_FILE, JSON.stringify(files, null, 2), "utf-8")
}

/**
 * Reads the persisted relevant-paths array from `.gates/relevant.json`.
 * Returns an empty array if the file does not exist or is unparseable.
 */
export const readRelevantPaths = async (): Promise<string[]> => {
  try {
    const { readFile } = await import("node:fs/promises")
    const raw = await readFile(RELEVANT_FILE, "utf-8")
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}