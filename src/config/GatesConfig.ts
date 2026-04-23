import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { load } from "js-yaml"

export interface ProviderConfig {
  base_url?: string
  // api_key is never stored here — goes to auth.json
}

export interface GatesConfig {
  version?: number
  provider?: string         // active provider name, e.g. "anthropic", "minimax"
  model?: string            // model name, e.g. "claude-sonnet-4-6", "minimax-m2.7"
  providers?: Record<string, ProviderConfig>
  context_scope?: "full" | "analyze_only"
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
  if (provider === "anthropic")  return "claude-sonnet-4-6"
  if (provider === "openai")     return "gpt-4o-mini"
  if (provider === "minimax")    return "minimax-m2.7"
  return "gpt-4o-mini"
}
