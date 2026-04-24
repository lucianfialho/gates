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
import { startChatTUI } from "./commands/chat.js"

// ─── CLI routing ──────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2)
const filteredArgs = rawArgs.filter(a => a !== "--verbose" && a !== "-v")
const verbose = rawArgs.includes("--verbose") || rawArgs.includes("-v")
const [cmd, ...rest] = filteredArgs

const USAGE = `
gates — autonomous coding agent

USAGE
  gates [--verbose] <prompt>                        run the agent with a direct prompt
  gates [--verbose] <skill> "<description>"         run a skill
  gates [--verbose] run <skill.yaml> [key=value .]  run a skill by path
  gates chat                                        interactive TUI
  gates simulate <skill.yaml> [key=value .]         trace skill flow without LLM calls
  gates stats                                       token usage and cost per run
  gates stats --json                                JSON output
  gates logs                                        list last 10 runs
  gates logs <runId>                                full event timeline for a run
  gates resume <run-id>                             resume a failed skill run
  gates auth set <key>                              save API key
  gates auth show                                   show stored key (masked)
  gates auth remove                                 delete stored key
  gates help                                        show this message
`.trim()

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

    case "chat": {
      await startChatTUI()
      break
    }

    case "simulate": {
      const { simulate } = await import("./machine/Simulate.js")
      const { resolve } = await import("node:path")
      const [skillPath, ...kvArgs] = rest
      if (!skillPath) { console.error("Usage: gates simulate <skill.yaml> [key=value ...]"); process.exit(1) }
      await simulate(resolve(skillPath), Object.fromEntries(kvArgs.flatMap(a => { const i = a.indexOf("="); return i > 0 ? [[a.slice(0, i), a.slice(i + 1)]] : [] })))
      break
    }

    case "help":
    case "--help":
    case "-h": {
      console.log(USAGE)
      break
    }

    default: {
      if (!cmd) {
        // No args → open TUI (default mode)
        await startChatTUI()
        break
      }

      // Skill shortcut: gates <token> → skills/<token>/skill.yaml
      const fs = await import("node:fs/promises")
      const skillPath = join(process.cwd(), "skills", cmd, "skill.yaml")
      const isSkill = await fs.access(skillPath).then(() => true).catch(() => false)
      if (isSkill) {
        await runSkillShortcut(cmd, rest, verbose)
        break
      }

      // Direct prompt — route through gateway
      const prompt = [cmd, ...rest].join(" ")
      await runGateway(prompt, undefined, verbose)
      break
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
