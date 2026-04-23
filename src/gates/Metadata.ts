import { Effect } from "effect"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { load } from "js-yaml"
import { GateError, type Gate, type ToolCall } from "./Gate.js"

const execFileAsync = promisify(execFile)

const STUB = `id: TODO
title: TODO
covers:
  - TODO
specialist: TODO
last_updated: TODO
status: stub
`

interface ConfigEntry {
  path: string
  specialist: string
}

interface GatesConfig {
  indexed_directories?: ConfigEntry[]
}

const loadConfig = async (cwd: string): Promise<GatesConfig | null> => {
  try {
    const raw = await readFile(join(cwd, ".gates", "config.yaml"), "utf-8")
    return load(raw) as GatesConfig
  } catch {
    return null
  }
}

const stagedFiles = async (cwd: string): Promise<string[]> => {
  const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd })
  return stdout.trim().split("\n").filter(Boolean)
}

const isGitCommit = (command: string): boolean => {
  const cmd = command.trim()
  return cmd.startsWith("git commit") && (cmd.length === 10 || /\s/.test(cmd[10] ?? ""))
}

const affectedDirs = (config: GatesConfig, staged: string[]): ConfigEntry[] =>
  (config.indexed_directories ?? []).filter((entry) => {
    const p = entry.path.replace(/\/$/, "")
    return staged.some((f) => f === p || f.startsWith(p + "/"))
  })

const ensureStub = async (cwd: string, dirPath: string): Promise<boolean> => {
  const summaryPath = join(cwd, dirPath, ".metadata", "summary.yaml")
  try {
    await readFile(summaryPath, "utf-8")
    return false  // already exists
  } catch {
    await mkdir(dirname(summaryPath), { recursive: true })
    await writeFile(summaryPath, STUB)
    return true  // created stub
  }
}

const checkSummary = async (cwd: string, dirPath: string, staged: string[]): Promise<string | null> => {
  const rel = `${dirPath}/.metadata/summary.yaml`
  const summaryPath = join(cwd, dirPath, ".metadata", "summary.yaml")

  if (!staged.includes(rel)) {
    return `${rel}: exists but is not staged. Update it and git add it.`
  }

  try {
    const raw = await readFile(summaryPath, "utf-8")
    const data = load(raw) as Record<string, unknown>
    if (data?.status !== "filled") {
      return `${rel}: status is "${data?.status}", must be "filled" before commit.`
    }
  } catch {
    return `${rel}: failed to read or parse.`
  }

  return null
}

export const metadataGate: Gate = {
  name: "metadata",

  matches: (call: ToolCall): boolean => {
    if (call.name !== "bash") return false
    const input = call.input as { command?: string }
    return isGitCommit(input.command ?? "")
  },

  check: (call: ToolCall): Effect.Effect<void, GateError> =>
    Effect.tryPromise({
      try: async () => {
        const cwd = process.cwd()
        const config = await loadConfig(cwd)
        if (!config) return  // no config.yaml → gate inactive

        const staged = await stagedFiles(cwd)
        if (!staged.length) return

        const affected = affectedDirs(config, staged)
        if (!affected.length) return

        const problems: string[] = []
        const stubsCreated: string[] = []

        for (const entry of affected) {
          const created = await ensureStub(cwd, entry.path)
          if (created) {
            stubsCreated.push(`${entry.path}/.metadata/summary.yaml`)
            continue
          }
          const err = await checkSummary(cwd, entry.path, staged)
          if (err) problems.push(err)
        }

        if (!stubsCreated.length && !problems.length) return

        const lines = ["gates: commit blocked — metadata problems found\n"]
        if (stubsCreated.length) {
          lines.push("Stub files created — fill these in and git add them:")
          stubsCreated.forEach((s) => lines.push(`  - ${s}`))
        }
        if (problems.length) {
          lines.push("\nProblems:")
          problems.forEach((p) => lines.push(`  - ${p}`))
        }
        lines.push(
          "\nWhy: directories in .gates/config.yaml indexed_directories must have",
          "an up-to-date .metadata/summary.yaml staged with every commit that touches them."
        )
        throw new Error(lines.join("\n"))
      },
      catch: (e) => new GateError("metadata", e instanceof Error ? e.message : String(e)),
    }),
}
