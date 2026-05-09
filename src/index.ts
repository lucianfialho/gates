#!/usr/bin/env node
/**
 * gates — AI Agent Harness
 *
 * CLI + Terminal UI for building and running AI agent pipelines.
 * Built on @gates-effect/runtime, @gates-effect/providers, @gates-effect/skills.
 */

import { Command } from "commander";

const program = new Command();

program
  .name("gates")
  .description("AI Agent Harness — build and run AI pipelines")
  .version("0.1.0");

// ── UI command (harness-ui) ───────────────────────────────────────────────────

program
  .command("ui", { isDefault: true })
  .description("Start the terminal UI (default)")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("-p, --port <number>", "Server port", "3583")
  .option("--server-only", "Start HTTP server without TUI", false)
  .action(async (options) => {
    const { startUI } = await import("./ui/index.js");
    await startUI(options);
  });

// ── CLI commands (gates-effect/cli equivalents) ───────────────────────────────

program
  .command("run <prompt>")
  .description("Run a one-shot agent prompt")
  .option("-p, --provider <provider>", "Provider (minimax, anthropic, openai)", "minimax")
  .option("-m, --model <model>", "Model to use")
  .option("--tools", "Enable tool calling", false)
  .option("-i, --max-iterations <number>", "Max tool iterations", "10")
  .action(async (prompt, options) => {
    const { run } = await import("./cli/commands/run.js");
    run(prompt, options);
  });

program
  .command("chat")
  .description("Start an interactive chat session")
  .option("-s, --session <id>", "Session ID", "default")
  .option("-p, --provider <provider>", "Provider", "minimax")
  .option("-m, --model <model>", "Model to use")
  .action(async (options) => {
    const { chat } = await import("./cli/commands/chat.js");
    chat(options);
  });

program
  .command("skill <name>")
  .description("Run a skill from .gates/skills/")
  .option("-i, --input <json>", "Input as JSON string")
  .option("-s, --sandbox <type>", "Sandbox type (memory, local)", "local")
  .option("-k, --api-key <key>", "API key for LLM calls")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (name, options) => {
    const { runSkill } = await import("./cli/commands/skill.js");
    await runSkill(name, options);
  });

program.parse();
