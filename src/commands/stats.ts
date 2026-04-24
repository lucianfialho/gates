#!/usr/bin/env bun
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { getBudget } from "../config/GatesConfig.js"

const truncate = (s: unknown, max = 60): { value: string; originalLength: number } => {
  const str = typeof s === "string" ? s : JSON.stringify(s)
  return { value: str.length > max ? str.slice(0, max) + "…" : str, originalLength: str.length }
}

export const runStats = async (rawArgs: string[], rest: string[]) => {
  const runsDir = join(process.cwd(), ".gates", "runs")
  let files: string[]
  const outputJson = rawArgs.includes("--json") || rest.includes("--json")

  try {
    files = (await readdir(runsDir)).filter((f) => f.endsWith(".jsonl"))
  } catch {
    console.log("No runs yet. Run: gates <prompt>")
    return
  }

  type Row = { ts: string; prompt: string; tin: number; tout: number; cost: number }
  const rows: Row[] = []
  let totalCacheHits = 0
  let totalCacheInvalidations = 0
  let totalTokensCached = 0

  for (const file of files) {
    const lines = (await readFile(join(runsDir, file), "utf-8")).split("\n").filter(Boolean)
    const parsed = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } }).filter(Boolean)
    const start = parsed.find((e) => e!.type === "run_start") as { prompt: string; ts: string; parentRunId?: string } | undefined
    const complete = parsed.find((e) => e!.type === "run_complete") as { total_input_tokens: number; total_output_tokens: number } | undefined
    const cacheMetrics = parsed.find((e) => e!.type === "cache_metrics") as { metrics: { cache_hits: number; cache_invalidations: number; tokens_cached: number } } | undefined
    if (!start || !complete) continue
    if (start.parentRunId) continue  // sub-run of a skill — skip, already counted in parent
    const tin = Number(complete.total_input_tokens) || 0
    const tout = Number(complete.total_output_tokens) || 0
    if (tin === 0 && tout === 0) continue
    // Sonnet 4.6: $3/MTok in, $15/MTok out
    const cost = (tin / 1_000_000) * 3 + (tout / 1_000_000) * 15
    const label = start.prompt.startsWith("skill:")
      ? (start.prompt.split(" inputs:")[0] ?? start.prompt)
      : start.prompt.slice(0, 55).replace(/\n/g, " ")
    rows.push({ ts: start.ts, prompt: label, tin, tout, cost })

    // Accumulate cache metrics
    if (cacheMetrics?.metrics) {
      totalCacheHits += cacheMetrics.metrics.cache_hits || 0
      totalCacheInvalidations += cacheMetrics.metrics.cache_invalidations || 0
      totalTokensCached += cacheMetrics.metrics.tokens_cached || 0
    }
  }

  rows.sort((a, b) => a.ts.localeCompare(b.ts))

  const totalIn = rows.reduce((s, r) => s + r.tin, 0)
  const totalOut = rows.reduce((s, r) => s + r.tout, 0)
  const totalCost = rows.reduce((s, r) => s + r.cost, 0)

  // Filter to current calendar month for budget bar
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth()
  const monthlyRows = rows.filter(r => {
    const d = new Date(r.ts)
    return d.getFullYear() === currentYear && d.getMonth() === currentMonth
  })
  const monthlyCost = monthlyRows.reduce((s, r) => s + r.cost, 0)

  if (outputJson) {
    const output = {
      rows: rows.map(r => ({ ts: r.ts, prompt: r.prompt, tin: r.tin, tout: r.tout, cost: r.cost })),
      totals: { tin: totalIn, tout: totalOut, cost: totalCost },
      cache_metrics: { cache_hits: totalCacheHits, cache_invalidations: totalCacheInvalidations, tokens_cached: totalTokensCached }
    }
    console.log(JSON.stringify(output))
    return
  }

  // Budget bar (hidden when budget is 0 or in --json mode)
  const budget = await getBudget()
  if (budget > 0) {
    const filled = Math.floor((monthlyCost / budget) * 20)
    const bar = "=".repeat(filled) + ".".repeat(Math.max(0, 20 - filled))
    console.log(` [${monthlyCost.toFixed(2)} / ${budget.toFixed(2)} ] [${bar}]`)
  }

  console.log(`\n${"date".padEnd(12)} ${"in tok".padStart(8)} ${"out tok".padStart(8)} ${"cost $".padStart(8)}  prompt`)
  console.log("─".repeat(90))
  for (const r of rows) {
    const date = r.ts.slice(0, 10)
    console.log(`${date.padEnd(12)} ${String(r.tin).padStart(8)} ${String(r.tout).padStart(8)} ${r.cost.toFixed(4).padStart(8)}  ${r.prompt}`)
  }
  console.log("─".repeat(90))
  console.log(`${"TOTAL".padEnd(12)} ${String(totalIn).padStart(8)} ${String(totalOut).padStart(8)} ${totalCost.toFixed(4).padStart(8)}`)

  // Print cache metrics if available
  if (totalCacheHits > 0 || totalCacheInvalidations > 0 || totalTokensCached > 0) {
    console.log("\nCache Metrics:")
    console.log(`  cache_hits:          ${totalCacheHits}`)
    console.log(`  cache_invalidations: ${totalCacheInvalidations}`)
    console.log(`  tokens_cached:       ${totalTokensCached}`)
  }
  console.log()
}
