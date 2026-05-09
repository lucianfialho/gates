import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import { getProviderConfig, type ProviderType } from "../providers/index.js";
import { makeMiniMaxProvider, makeAnthropicProvider, makeOpenAIProvider } from "@gatesai/providers";
import type { Provider, Message as ProviderMessage, ToolResult as ProviderToolResult } from "@gatesai/providers";
import { makeSandbox } from "@gatesai/sandbox";
import { toolsMap, type Tool } from "@gatesai/runtime";

interface DevOptions {
  watch?: string;
  provider: ProviderType;
  model?: string;
  maxIterations?: number;
}

const createProvider = (providerName: ProviderType, apiKey: string, model?: string): Provider => {
  switch (providerName) {
    case "minimax":
      return makeMiniMaxProvider({ apiKey, model });
    case "anthropic":
      return makeAnthropicProvider({ apiKey, model });
    case "openai":
      return makeOpenAIProvider({ apiKey, model });
  }
};

const PROVIDER_TOOLS: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [
  { name: "read",  description: "Read file contents",          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write", description: "Write content to a file",     parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "bash",  description: "Execute a bash command",      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "glob",  description: "Find files matching a pattern", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "grep",  description: "Search for text in files",    parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" } }, required: ["query"] } },
  { name: "edit",  description: "Edit a file by replacing text", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] } },
];

const executeTool = (name: string, args: string, tools: Map<string, Tool>): Effect.Effect<{ content: string; isError: boolean }> =>
  Effect.gen(function* () {
    const tool = tools.get(name);
    if (!tool) return { content: `Tool "${name}" not found`, isError: true };
    const result = yield* tool.execute(JSON.parse(args));
    return { content: result.content, isError: result.isError ?? false };
  });

const formatToolResult = (toolCallId: string, content: string): ProviderMessage => ({
  role: "user",
  content: "",
  timestamp: Date.now(),
  toolResults: [{ toolCallId, content } satisfies ProviderToolResult],
});

interface WatchState {
  running: boolean;
  debounceTimer: NodeJS.Timeout | null;
}

const watchPatterns = (patterns: string[], onChange: () => void, state: WatchState): void => {
  console.log(`\n👀 Watching for changes:`);
  for (const p of patterns) {
    console.log(`   - ${p}`);
  }
  console.log("   Press Ctrl+C to stop\n");

  const watchers: fs.FSWatcher[] = [];

  for (const pattern of patterns) {
    const dir = pattern.includes("*") ? pattern.split("*")[0] || "." : pattern;
    const basename = path.basename(pattern);

    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        if (!filename) return;

        const matches = basename === "*" || filename === basename || filename.match(new RegExp("^" + basename.replace("*", ".*") + "$"));

        if (matches && !state.running) {
          if (state.debounceTimer) {
            clearTimeout(state.debounceTimer);
          }
          state.debounceTimer = setTimeout(() => {
            state.running = false;
            onChange();
          }, 300);
        }
      });
      watchers.push(watcher);
      console.log(`   Watching: ${dir} (${basename})`);
    } catch (e) {
      console.error(`   Failed to watch ${pattern}: ${e}`);
    }
  }

  process.on("SIGINT", () => {
    console.log("\n\n👋 Stopping watch mode...");
    watchers.forEach((w) => w.close());
    process.exit(0);
  });
};

const runDev = (prompt: string, provider: Provider, maxIterations: number) =>
  Effect.gen(function* () {
    const sandbox = yield* makeSandbox("local");
    const tools = toolsMap(sandbox);

    let messages: ProviderMessage[] = [
      { role: "user", content: prompt, timestamp: Date.now() }
    ];
    let iteration = 0;
    let finalContent = "";

    while (iteration < maxIterations) {
      const response = yield* Effect.mapError(
        provider.chat(messages, PROVIDER_TOOLS),
        (e) => new Error(e.message)
      );

      finalContent = response.content;

      if (!response.toolCalls || response.toolCalls.length === 0) break;

      console.log(`\n🔧 Iteration ${iteration + 1}: ${response.toolCalls.length} tool call(s)`);
      for (const tc of response.toolCalls) {
        console.log(`   ${tc.name}(${tc.arguments})`);
      }

      messages.push({
        role: "assistant",
        content: response.content,
        timestamp: Date.now(),
        toolCalls: response.toolCalls,
      });

      const results = yield* Effect.all(
        response.toolCalls.map((tc) =>
          Effect.map(executeTool(tc.name, tc.arguments, tools), (r) => ({ tc, r }))
        )
      );

      for (const { tc, r } of results) {
        console.log(`   → ${r.content.substring(0, 120)}${r.content.length > 120 ? "..." : ""}`);
        messages.push(formatToolResult(tc.id, r.content));
      }

      iteration++;
    }

    return { content: finalContent, iterations: iteration };
  });

const doDev = (prompt: string, options: DevOptions): void => {
  const { apiKey, model: configModel } = getProviderConfig(options.provider);

  if (!apiKey) {
    console.error(`Missing API key. Run 'gates connect' first.`);
    return;
  }

  const model = options.model ?? configModel;
  const provider = createProvider(options.provider, apiKey, model);

  console.log(`\n🚀 Gates Dev Mode`);
  console.log(`Provider: ${options.provider} (${model})`);
  console.log(`Prompt: "${prompt}"`);
  console.log("─".repeat(40));

  const state: WatchState = { running: false, debounceTimer: null };

  const maxIterations = options.maxIterations ?? 10;

  const execute = () => {
    state.running = true;
    console.log("\n🔄 Running...\n");

    Effect.runPromise(runDev(prompt, provider, maxIterations)).then(
      ({ content, iterations }) => {
        console.log(`\n📤 Output:\n${content}`);
        if (iterations > 0) console.log(`\n  [Iterations: ${iterations}]`);
        state.running = false;
      },
      (e: unknown) => {
        const err = e as { message?: string };
        console.error(`\n❌ Error: ${err.message ?? String(e)}`);
        state.running = false;
      }
    );
  };

  execute();

  if (options.watch) {
    const patterns = options.watch.split(",").map((p) => p.trim());
    watchPatterns(patterns, execute, state);
  }
};

export const dev = (prompt: string, options: DevOptions): void => {
  doDev(prompt, options);
};