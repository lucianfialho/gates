#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("gates")
  .description("AI Agent Harness — build and run AI pipelines")
  .version("0.1.0");

// ── UI (default command) ──────────────────────────────────────────────────────

program
  .command("ui", { isDefault: true })
  .description("Start the terminal UI (default when no command given)")
  .option("-d, --dir <path>", "Project directory", process.cwd())
  .option("-p, --port <number>", "Server port", "3583")
  .option("--server-only", "Start HTTP server without TUI", false)
  .action(async (options) => {
    const { resolve } = await import("path");
    const dir = resolve(process.cwd(), options.dir as string);
    process.chdir(dir);

    const { discoverHarnesses } = await import("./ui/harness/loader.js");
    const { startServer, DEFAULT_PORT } = await import("./ui/server/index.js");
    const { render } = await import("ink");
    const React = await import("react");
    const { App } = await import("./ui/tui/app.js");

    const port = Number(options.port);
    const harnesses = await discoverHarnesses(dir);

    if (harnesses.length === 0) {
      console.error("No harnesses found. Create one in .gates/harnesses/");
      process.exit(1);
    }

    const stopServer = await startServer(harnesses, port);
    await new Promise((r) => setTimeout(r, 100));

    const isTTY = process.stdin.isTTY;
    if ((options as { serverOnly: boolean }).serverOnly || !isTTY) {
      console.log(`gates server running on http://localhost:${port}`);
      console.log(`Harnesses: ${harnesses.map((h) => h.name).join(", ")}`);
      console.log("Press Ctrl+C to stop.");
      process.on("SIGINT", () => { stopServer(); process.exit(0); });
      return;
    }

    const { waitUntilExit } = render(React.default.createElement(App, { harnesses }));
    await waitUntilExit();
    stopServer();
    process.exit(0);
  });

// ── CLI commands ──────────────────────────────────────────────────────────────

program
  .command("run <prompt>")
  .description("Run a one-shot agent prompt")
  .option("-p, --provider <provider>", "Provider (minimax, anthropic, openai)", "minimax")
  .option("-m, --model <model>", "Model to use")
  .option("-t, --temperature <number>", "Temperature", "0.7")
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
  .option("-p, --provider <provider>", "Provider (minimax, anthropic, openai)", "minimax")
  .option("-m, --model <model>", "Model to use")
  .action(async (options) => {
    const { chat } = await import("./cli/commands/chat.js");
    chat(options);
  });

program
  .command("resume <session-id> <prompt>")
  .description("Resume an existing session")
  .option("-p, --provider <provider>", "Provider", "minimax")
  .option("-m, --model <model>", "Model to use")
  .action(async (sessionId, prompt, options) => {
    const { resume } = await import("./cli/commands/resume.js");
    resume(sessionId, prompt, options);
  });

program
  .command("dev <prompt>")
  .description("Run agent with tools in dev mode")
  .option("-w, --watch <patterns>", "File patterns to watch")
  .option("-p, --provider <provider>", "Provider", "minimax")
  .option("-m, --model <model>", "Model to use")
  .option("-i, --max-iterations <number>", "Max tool iterations", "10")
  .action(async (prompt, options) => {
    const { dev } = await import("./cli/commands/dev.js");
    dev(prompt, options);
  });

program
  .command("skill <name>")
  .description("Run a skill from .gates/skills/")
  .option("-i, --input <json>", "Input as JSON string")
  .option("-s, --sandbox <type>", "Sandbox type (memory, local)", "local")
  .option("-p, --path <path>", "Base path for skills")
  .option("-k, --api-key <key>", "API key for LLM calls")
  .option("-v, --verbose", "Verbose output", false)
  .action(async (name, options) => {
    const { runSkill, parseSkillInput, findSkillPath } = await import("./cli/commands/run-skill.js");
    const basePath = (options.path as string) ?? process.env.GATES_BASE ?? process.cwd();
    const skillPath = findSkillPath(name, basePath);
    const input = options.input ? parseSkillInput(options.input as string) : {};
    await runSkill({
      skillPath,
      input,
      sandboxType: (options.sandbox as "memory" | "local") ?? "local",
      verbose: (options.verbose as boolean) ?? false,
      apiKey: options.apiKey as string | undefined,
    });
  });

program
  .command("sessions")
  .description("List saved sessions")
  .action(async () => {
    const { sessions } = await import("./cli/commands/sessions.js");
    sessions({});
  });

program
  .command("login")
  .description("Configure API key for a provider")
  .option("-p, --provider <provider>", "Provider")
  .option("-k, --key <key>", "API key")
  .action(async (options) => {
    const { login } = await import("./cli/commands/login.js");
    login(options);
  });

program
  .command("onboarding")
  .description("Reset onboarding — open configuration wizard on next launch")
  .option("--now", "Open configuration wizard immediately", false)
  .action(async (options) => {
    const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");

    const configPath = join(homedir(), ".gates", "config.json");
    mkdirSync(join(homedir(), ".gates"), { recursive: true });

    const existing = (() => {
      try { return JSON.parse(readFileSync(configPath, "utf-8")); }
      catch { return {}; }
    })();

    delete existing._onboarded;
    writeFileSync(configPath, JSON.stringify(existing, null, 2));
    console.log("✓ Onboarding reset — configuration wizard will open on next launch.");

    if (options.now) {
      console.log("Opening configuration wizard...");
      // Re-run gates to trigger onboarding
      const { execFileSync } = await import("child_process");
      try {
        execFileSync(process.argv[1]!, [], { stdio: "inherit" });
      } catch { /* user closed */ }
    }
  });

program.parse();
