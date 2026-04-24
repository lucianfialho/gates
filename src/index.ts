#!/usr/bin/env bun
/**
 * gates — CLI entry point
 * Routes sub-commands to the appropriate handler.
 */
import { join } from "node:path"

import { runAuth } from "./commands/auth.js"
import { runStats } from "./commands/stats.js"
import { runLogs } from "./commands/logs.js"
import { runResume } from "./commands/resume.js"
import { runSkillShortcut, runSkillByPath } from "./commands/skill.js"
import { runGateway } from "./commands/gateway.js"

// ─── CLI routing ──────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2)
const verbose = rest.includes("--verbose") || rest.includes("-v")
const rawArgs = process.argv.slice(2)

async function main() {
  switch (cmd) {
    case "auth": {
      await runAuth(rest)
      break
    }

    case "stats": {
      await runStats(rawArgs, rest)
      break
    }

    case "logs": {
      const [first] = rest
      // If the first token looks like a run ID (hex or uuid), treat as run-specific log
      const runId = /^[a-f0-9-]{8,}/i.test(first ?? "") ? first : undefined
      await runLogs(runId)
      break
    }

    case "resume": {
      await runResume(rest[0] ?? "", verbose)
      break
    }

    case "run": {
      await runSkillByPath(rest[0] ?? "", rest.slice(1), verbose)
      break
    }

    case "gateway": {
      const [gatewayPrompt] = rest
      await runGateway(gatewayPrompt ?? "", undefined, verbose)
      break
    }

    default: {
      // Skill shortcut: gates <token> [inputs...]  →  gates run skills/<token>/skill.yaml inputs...
      const fs = await import("node:fs/promises")
      const skillPath = join(process.cwd(), "skills", cmd ?? "", "skill.yaml")
      try {
        await fs.access(skillPath)
      } catch {
        console.error("Usage:\n  gates <prompt>              Run an agent with a prompt\n  gates auth <sub>             Manage API keys\n  gates stats [--json]          Show run statistics\n  gates logs [run-id]          View run logs\n  gates resume <run-id>         Resume a failed run\n  gates run <skill.yaml>        Run a skill\n  gates gateway <prompt>        Run via gateway classifier")
        process.exit(1)
      }
      const handled = await runSkillShortcut(cmd ?? "", rest, verbose)
      if (!handled) {
        console.error(`Error: skill not found at ${skillPath}`)
        process.exit(1)
      }
      break
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})