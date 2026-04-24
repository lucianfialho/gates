/**
 * gates — CLI argument parsing
 * Handles filtering, verbose flag, and base command routing.
 */
import { join } from "node:path"

// Static imports for filesystem-only commands (no LLMService needed)
import { runAuth } from "../commands/auth.js"
import { runStats } from "../commands/stats.js"
import { runLogs } from "../commands/logs.js"
import { runClean } from "../commands/clean.js"
import { runVersion } from "../commands/version.js"
import { runDoctor } from "../commands/doctor.js"
// LLM-dependent commands are lazy-imported to avoid LLMService initialization
// for simple filesystem commands (stats, logs, version, doctor, etc.)

const rawArgs = process.argv.slice(2)
const filteredArgs = rawArgs.filter(a => a !== "--verbose" && a !== "-v")
const verbose = rawArgs.includes("--verbose") || rawArgs.includes("-v")
const [cmd, ...rest] = filteredArgs

export async function routeCommand() {
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

    case "clean": {
      const keepArg = rest[0] === "--keep" ? rest[1] : undefined
      await runClean(keepArg)
      break
    }

    case "resume": {
      const { runResume } = await import("../commands/resume.js")
      await runResume(rest[0] ?? "", verbose)
      break
    }

    case "run": {
      const { runSkillByPath } = await import("../commands/skill.js")
      await runSkillByPath(rest[0] ?? "", rest.slice(1), verbose)
      break
    }

    case "chat": {
      const { startChatTUI } = await import("../commands/chat.js")
      await startChatTUI()
      break
    }

    case "doctor": {
      await runDoctor(rawArgs)
      break
    }

    case "--version":
    case "-V":
    case "version": {
      await runVersion()
      break
    }

    case "simulate": {
      const { simulate } = await import("../machine/Simulate.js")
      const { resolve } = await import("node:path")
      const [skillPath, ...kvArgs] = rest
      if (!skillPath) { console.error("Usage: gates simulate <skill.yaml> [key=value ...]"); process.exit(1) }
      await simulate(resolve(skillPath), Object.fromEntries(kvArgs.flatMap(a => { const i = a.indexOf("="); return i > 0 ? [[a.slice(0, i), a.slice(i + 1)]] : [] })))
      break
    }

    case "help":
    case "--help":
    case "-h": {
      const { USAGE } = await import("./usage.js")
      console.log(USAGE)
      break
    }

    default: {
      if (!cmd) {
        // No args → open TUI (default mode, lazy — needs LLMService)
        const { startChatTUI } = await import("../commands/chat.js")
        await startChatTUI()
        break
      }

      // Skill shortcut: gates <token> → skills/<token>/skill.yaml
      const fs = await import("node:fs/promises")
      const skillPath = join(process.cwd(), "skills", cmd, "skill.yaml")
      const isSkill = await fs.access(skillPath).then(() => true).catch(() => false)
      if (isSkill) {
        const { runSkillShortcut } = await import("../commands/skill.js")
        await runSkillShortcut(cmd, rest, verbose)
        break
      }

      // Direct prompt — route through gateway (lazy import — needs LLMService)
      const { runGateway } = await import("../commands/gateway.js")
      const prompt = [cmd, ...rest].join(" ")
      await runGateway(prompt, undefined, verbose)
      break
    }
  }
}
