#!/usr/bin/env bun
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

const truncate = (s: unknown, max = 60): { value: string; originalLength: number } => {
  const str = typeof s === "string" ? s : JSON.stringify(s)
  return { value: str.length > max ? str.slice(0, max) + "…" : str, originalLength: str.length }
}

const ANSI = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", blue: "\x1b[34m", dim: "\x1b[2m" }
const colorize = (type: string, text: string): string => {
  const c = type.includes("pass") || type.includes("complete") ? ANSI.green :
            type.includes("block") || type.includes("fail") ? ANSI.red :
            type.includes("request") || type.includes("call") ? ANSI.yellow :
            type.includes("response") || type.includes("result") ? ANSI.blue : ANSI.dim
  return `${c}${text}${ANSI.reset}`
}

export const runLogs = async (runId?: string) => {
  const runsDir = join(process.cwd(), ".gates", "runs")
  let files: string[]
  try {
    files = (await readdir(runsDir)).filter((f) => f.endsWith(".jsonl"))
  } catch {
    console.log("No runs yet. Run: gates <prompt>")
    return
  }

  if (runId) {
    // Locate file by full id or prefix match
    const match = files.find((f) => f === `${runId}.jsonl` || f.startsWith(runId))
    if (!match) {
      console.error(`No run found matching: ${runId}`)
      process.exit(1)
    }
    const lines = (await readFile(join(runsDir, match), "utf-8")).split("\n").filter(Boolean)
    const events = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } }).filter(Boolean)
    console.log(`\nRun: ${match.replace(".jsonl", "")}`)
    console.log("─".repeat(100))
    console.log(`${"timestamp".padEnd(28)} ${"event".padEnd(15)} ${"gate".padEnd(20)} ${"tool".padEnd(15)} duration`)
    console.log("─".repeat(100))
    for (const ev of events) {
      const rawTs = ev!.ts as string ?? ""
      const timestamp = rawTs.length >= 19 ? rawTs : ""
      const type = String(ev!.type ?? "unknown")
      const gate = String(ev!.gate ?? "")
      const tool = String(ev!.tool ?? "")
      const duration = ev!.duration !== undefined ? `${ev!.duration}ms` : ""

      let detail = ""
      if (type === "run_start") {
        const { value, originalLength } = truncate(ev!.prompt, 60)
        detail = `prompt="${value}"${originalLength > 60 ? ` [${originalLength} chars]` : ""}`
      } else if (type === "run_complete") {
        detail = `input_tokens=${ev!.total_input_tokens} output_tokens=${ev!.total_output_tokens}`
      } else if (type === "llm_response") {
        detail = `stop_reason=${ev!.stop_reason} input_tokens=${ev!.input_tokens} output_tokens=${ev!.output_tokens}`
      } else if (type === "gate_block") {
        const { value, originalLength } = truncate(ev!.reason, 60)
        detail = `reason="${value}"${originalLength > 60 ? ` [${originalLength} chars]` : ""}`
      } else if (type === "tool_result") {
        const { value, originalLength } = truncate(ev!.content, 60)
        detail = `content="${value}"${originalLength > 60 ? ` [${originalLength} chars]` : ""}`
      } else if (type === "cache_metrics") {
        detail = `cache_hits=${ev!.cache_hits} cache_invalidations=${ev!.cache_invalidations} tokens_cached=${ev!.tokens_cached}`
      } else {
        // Render remaining fields except type, ts, and known fields
        const rest = Object.entries(ev!).filter(([k]) => !["type", "ts", "gate", "tool", "duration"].includes(k))
        const { value, originalLength } = truncate(rest.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" "), 60)
        detail = `${value}${originalLength > 60 ? ` [${originalLength} chars]` : ""}`
      }

      const line = [
        timestamp.padEnd(28),
        colorize(type, type.padEnd(15)),
        gate.padEnd(20),
        tool.padEnd(15),
        duration,
        detail,
      ].join(" ")
      console.log(line)
    }
    console.log("─".repeat(100))
    console.log()
    return
  }

  // List mode — last 10 runs
  type RunRow = { ts: string; id: string; tin: number; tout: number; prompt: string }
  const rows: RunRow[] = []

  for (const file of files) {
    const lines = (await readFile(join(runsDir, file), "utf-8")).split("\n").filter(Boolean)
    const parsed = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } }).filter(Boolean)
    const start = parsed.find((e) => e!.type === "run_start") as { prompt: string; ts: string } | undefined
    const complete = parsed.find((e) => e!.type === "run_complete") as { total_input_tokens: number; total_output_tokens: number } | undefined
    if (!start) continue
    const tin = complete ? Number(complete.total_input_tokens) || 0 : 0
    const tout = complete ? Number(complete.total_output_tokens) || 0 : 0
    const id = file.replace(".jsonl", "")
    const { value: prompt } = truncate(start.prompt, 50)
    rows.push({ ts: start.ts, id, tin, tout, prompt })
  }

  rows.sort((a, b) => b.ts.localeCompare(a.ts))
  const recent = rows.slice(0, 10)

  console.log(`\n${"id".padEnd(10)} ${"date".padEnd(12)} ${"in tok".padStart(8)} ${"out tok".padStart(8)}  prompt`)
  console.log("─".repeat(90))
  for (const r of recent) {
    const date = r.ts.slice(0, 16).replace("T", " ")
    console.log(`${r.id.slice(0, 8).padEnd(10)} ${date.padEnd(12)} ${String(r.tin).padStart(8)} ${String(r.tout).padStart(8)}  ${r.prompt}`)
  }
  console.log("─".repeat(90))
  console.log()
}
