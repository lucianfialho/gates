#!/usr/bin/env bun
import { Effect } from "effect"
import { runDoctorEffect, type DoctorContext } from "./doctor.internal.js"

const renderDoctor = (ctx: DoctorContext, outputJson: boolean): void => {
  const { configExists, indexedDirs, dirHealthList, contextExists, gateCount } = ctx

  if (!configExists) {
    if (outputJson) {
      console.log(JSON.stringify({
        config_exists: false,
        indexed_count: 0,
        indexed_dirs: [],
        context_exists: false,
        gate_count: gateCount,
      }))
    } else {
      console.log("❌ .gates/config.yaml not found")
      console.log("   Run: gates auth to initialize")
      console.log(`\nregistered gates: ${gateCount}`)
    }
    return
  }

  if (outputJson) {
    const output: Record<string, unknown> = {
      config_exists: true,
      indexed_count: indexedDirs.length,
      indexed_dirs: indexedDirs.map(e => e.path),
      context_exists: contextExists,
      gate_count: gateCount,
    }
    for (const h of dirHealthList) {
      output[`${h.dir}_summary_exists`] = h.summary_exists
      output[`${h.dir}_status`] = h.status
      output[`${h.dir}_healthy`] = h.healthy
    }
    console.log(JSON.stringify(output))
    return
  }

  // Human-readable output
  console.log("gates doctor — health report\n")

  // Config status
  console.log(`config:      ${configExists ? "✓ found" : "✗ missing"}`)

  // Registered gates
  console.log(`gates:       ${gateCount} registered`)

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

export async function runDoctor(rawArgs: string[]): Promise<void> {
  const outputJson = rawArgs.includes("--json")
  const cwd = process.cwd()

  const ctx = await Effect.runPromise(runDoctorEffect(cwd, outputJson))

  renderDoctor(ctx, outputJson)
}
