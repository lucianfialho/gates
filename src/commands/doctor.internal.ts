import { Effect } from "effect"
import { readFile, access } from "node:fs/promises"
import { join } from "node:path"
import { load } from "js-yaml"
import { loadGatesConfig } from "../config/GatesConfig.js"
import { getBuiltinGateCount } from "../gates/builtin.js"

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

export interface DoctorContext {
  configExists: boolean
  indexedDirs: { path: string }[]
  dirHealthList: DirHealth[]
  contextExists: boolean
  gateCount: number
}

export const runDoctorEffect = (cwd: string, outputJson: boolean): Effect.Effect<DoctorContext> =>
  Effect.gen(function* () {
    // 1. Check if .gates/config.yaml exists
    const configPath = join(cwd, ".gates", "config.yaml")
    const configExists = yield* Effect.promise(() => fileExists(configPath))

    if (!configExists) {
      return {
        configExists: false,
        indexedDirs: [],
        dirHealthList: [],
        contextExists: false,
        gateCount: getBuiltinGateCount(),
      }
    }

    // 2. Load config and read indexed_directories
    const config = yield* Effect.promise(() => loadGatesConfig())
    const indexedDirs = config.indexed_directories ?? []

    // 3. Check each indexed directory for .metadata/summary.yaml
    const dirHealthList: DirHealth[] = []
    for (const entry of indexedDirs) {
      const health = yield* Effect.promise(() => checkDirHealth(cwd, entry.path))
      dirHealthList.push(health)
    }

    // 4. Compute overall context_exists
    const allHealthy = dirHealthList.length > 0 && dirHealthList.every(h => h.healthy)
    const contextExists = configExists && allHealthy

    return {
      configExists: true,
      indexedDirs,
      dirHealthList,
      contextExists,
      gateCount: getBuiltinGateCount(),
    }
  })
