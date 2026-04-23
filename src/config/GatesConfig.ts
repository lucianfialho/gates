import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { load } from "js-yaml"

export interface ProviderConfig {
  base_url?: string
  // api_key is never stored here — goes to auth.json
}

export interface IndexedDirectory {
  path: string
  specialist?: string
}

export interface GatesConfig {
  version?: number
  provider?: string
  model?: string
  providers?: Record<string, ProviderConfig>
  context_scope?: "full" | "analyze_only"
  indexed_directories?: IndexedDirectory[]
  budget?: number
}

export const getBudget = async (): Promise<number> => {
  // GATES_BUDGET env var takes precedence if set and > 0
  const envBudget = parseInt(process.env["GATES_BUDGET"] ?? "", 10)
  if (!isNaN(envBudget) && envBudget > 0) {
    return envBudget
  }
  // Fall back to config.budget if set and > 0
  const cfg = await loadGatesConfig()
  if (cfg.budget != null && cfg.budget > 0) {
    return cfg.budget
  }
  // Default to 10
  return 10
}

let _cache: GatesConfig | null = null

export const loadGatesConfig = async (): Promise<GatesConfig> => {
  if (_cache) return _cache
  try {
    const raw = await readFile(join(process.cwd(), ".gates", "config.yaml"), "utf-8")
    _cache = (load(raw) as GatesConfig) ?? {}
  } catch {
    _cache = {}
  }
  return _cache
}

export const getProviderConfig = async (): Promise<{
  provider: string
  model: string
  baseURL?: string
}> => {
  const cfg = await loadGatesConfig()

  // env vars always win
  const provider = process.env["GATES_PROVIDER"] ?? cfg.provider ?? "anthropic"
  const model    = process.env["GATES_MODEL"]    ?? cfg.model    ?? defaultModelFor(provider)
  const baseURL  = process.env["GATES_BASE_URL"] ?? cfg.providers?.[provider]?.base_url

  return { provider, model, ...(baseURL ? { baseURL } : {}) }
}

const defaultModelFor = (provider: string): string => {
  if (provider === "anthropic" || provider.toLowerCase() === "anthropic")  return "claude-sonnet-4-6"
  if (provider === "openai"     || provider.toLowerCase() === "openai")     return "gpt-4o-mini"
  if (provider === "minimax"    || provider.toLowerCase() === "minimax")    return "minimax-m2.7"
  return "gpt-4o-mini"
}
