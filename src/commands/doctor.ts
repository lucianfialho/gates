#!/usr/bin/env bun
import { readFile, access } from "node:fs/promises"
import { join } from "node:path"
import { load } from "js-yaml"
import { loadGatesConfig } from "../config/GatesConfig.js"

interface SummaryYaml {
  status?: string
  [key: string]: unknown
}

interface DirHealth {
  dir: string
  summary_exists: boolean
  status: string | null
  healthy: boolean
}

const SUMMARY_STUB_STATUS = "stub"

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const checkDirHealth = async (cwd: string, dirPath: string): Promise<DirHealth> => {
  const summaryPath = join(cwd, dirPath, ".metadata", "summary.yaml")
  const exists = await fileExists(summaryPath)

  if (!exists) {
    return { dir: dirPath, summary_exists: false, status: null, healthy: false }
  }

  try {
    const raw = await readFile(summaryPath, "utf-8")
    const data = load(raw) as SummaryYaml
    const status = data?.status ?? SUMMARY_STUB_STATUS
    return { dir: dirPath, summary_exists: true, status, healthy: status === "filled" }
  } catch {
    return { dir: dirPath, summary_exists: true, status: null, healthy: false }
  }
}

export async function runDoctor(rawArgs: string[]): Promise<void> {
  const outputJson = rawArgs.includes("--json")
  const cwd = process.cwd()

  // 1. Check if .gates/config.yaml exists
  const configPath = join(cwd, ".gates", "config.yaml")
  const configExists = await fileExists(configPath)

  if (!configExists) {
    if (outputJson) {
      console.log(JSON.stringify({
        config_exists: false,
        indexed_count: 0,
        indexed_dirs: [],
        context_exists: false,
      }))
    } else {
      console.log("❌ .gates/config.yaml not found")
      console.log("   Run: gates auth to initialize")
    }
    return
  }

  // 2. Load config and read indexed_directories
  const config = await loadGatesConfig()
  const indexedDirs = config.indexed_directories ?? []

  // 3. Check each indexed directory for .metadata/summary.yaml
  const dirHealthList: DirHealth[] = []
  for (const entry of indexedDirs) {
    const health = await checkDirHealth(cwd, entry.path)
    dirHealthList.push(health)
  }

  // 4. Compute overall context_exists (all dirs healthy = context is intact)
  const allHealthy = dirHealthList.length > 0 && dirHealthList.every(h => h.healthy)
  const contextExists = configExists && allHealthy

  if (outputJson) {
    const output = {
      config_exists: true,
      indexed_count: indexedDirs.length,
      indexed_dirs: indexedDirs.map(e => e.path),
      context_exists: contextExists,
    }
    // Append per-dir health fields
    for (const h of dirHealthList) {
      ;(output as Record<string, unknown>)[`${h.dir}_summary_exists`] = h.summary_exists
      ;(output as Record<string, unknown>)[`${h.dir}_status`] = h.status
      ;(output as Record<string, unknown>)[`${h.dir}_healthy`] = h.healthy
    }
    console.log(JSON.stringify(output))
    return
  }

  // Human-readable output
  console.log("gates doctor — health report\n")

  // Config status
  console.log(`config:      ${configExists ? "✓ found" : "✗ missing"}`)

  // Indexed directories
  console.log(`indexed:     ${indexedDirs.length} dir(s)`)
  for (const entry of indexedDirs) {
    const health = dirHealthList.find(h => h.dir === entry.path)
    if (!health) continue
    const status = health.summary_exists
      ? `status=${health.status ?? "?"}`
      : "summary missing"
    const ok = health.healthy ? "✓" : "✗"
    console.log(`  ${ok} ${entry.path}/.metadata/summary.yaml — ${status}`)
  }

  // Overall context health
  console.log(`\ncontext:     ${contextExists ? "✓ healthy" : "✗ incomplete"}`)

  // Summary
  if (contextExists) {
    console.log("\nAll checks passed ✓")
  } else {
    const issues = dirHealthList.filter(h => !h.healthy)
    if (issues.length > 0) {
      console.log(`\n${issues.length} issue(s) found:`)
      for (const issue of issues) {
        if (!issue.summary_exists) {
          console.log(`  ✗ ${issue.dir}/.metadata/summary.yaml — file missing`)
        } else {
          console.log(`  ✗ ${issue.dir}/.metadata/summary.yaml — status "${issue.status ?? "(unknown)"}" is not "filled"`)
        }
      }
    }
  }
}
