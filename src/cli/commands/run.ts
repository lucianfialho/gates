import { Effect } from "effect";
import { getProviderConfig, type ProviderType } from "../providers/index.js";
import { makeMiniMaxProvider, makeAnthropicProvider, makeOpenAIProvider } from "@gatesai/providers";
import type { Provider, Message as ProviderMessage, ToolCall as ProviderToolCall, ToolResult as ProviderToolResult } from "@gatesai/providers";
import { makeSandbox } from "@gatesai/sandbox";
import { toolsMap, type Tool, type Message } from "@gatesai/runtime";

interface RunOptions {
  provider: ProviderType;
  model?: string;
  temperature: number;
  tools?: boolean;
  maxIterations?: number;
  sandboxType?: "memory" | "local";
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

interface ProviderTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const toProviderMessage = (msg: Message): ProviderMessage => {
  if (msg.role === "tool") {
    let toolResult: ProviderToolResult;
    try {
      const parsed = JSON.parse(msg.content);
      toolResult = parsed;
    } catch {
      toolResult = { toolCallId: "", content: msg.content };
    }
    return {
      role: "user",
      content: "",
      timestamp: msg.timestamp,
      toolResults: [toolResult],
    };
  }
  return {
    role: msg.role as "user" | "assistant" | "system" | "context",
    content: msg.content,
    timestamp: msg.timestamp,
  };
};

const executeTool = (name: string, args: string, tools: Map<string, Tool>): Effect.Effect<{ content: string; isError: boolean }> =>
  Effect.gen(function* () {
    const tool = tools.get(name);
    if (!tool) {
      return { content: `Tool "${name}" not found`, isError: true };
    }
    const result = yield* tool.execute(JSON.parse(args));
    return { content: result.content, isError: result.isError ?? false };
  });

const formatToolResultMessage = (toolCallId: string, content: string): ProviderMessage => ({
  role: "user",
  content: "",
  timestamp: Date.now(),
  toolResults: [{ toolCallId, content, isError: false }],
});

const doRun = (prompt: string, options: RunOptions) =>
  Effect.gen(function* () {
    const { apiKey, model: configModel } = getProviderConfig(options.provider);

    if (!apiKey) {
      console.error(`Missing API key. Run 'gates connect' first.`);
      return;
    }

    const sandboxType = options.sandboxType ?? "local";
    const sandbox = yield* makeSandbox(sandboxType);
    const sandboxToolsMap = toolsMap(sandbox);

    const model = options.model ?? configModel;
    const provider = createProvider(options.provider, apiKey, model);

    const toolEnabled = options.tools ?? false;

    console.log(`\nUsing ${options.provider}${model ? ` (${model})` : ""}${toolEnabled ? " [tools enabled]" : ""}...\n`);

    const initialMessages: Message[] = [
      { id: crypto.randomUUID(), role: "user", content: prompt, timestamp: Date.now() }
    ];

    if (!toolEnabled) {
      const providerMessages: ProviderMessage[] = initialMessages.map(toProviderMessage);
      const result = yield* Effect.result(provider.chat(providerMessages));

      if (result._tag === "Success") {
        console.log(result.success.content);
        console.log(`\n  [Tokens: ${result.success.usage.totalTokens}]`);
      } else {
        const e = result.failure as { message?: string };
        console.error(`Error: ${e.message ?? result.failure}`);
      }
      return;
    }

    const providerTools: ProviderTool[] = [
      { name: "read", description: "Read file contents", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write", description: "Write content to a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "bash", description: "Execute a bash command", parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] } },
      { name: "glob", description: "Find files matching a pattern", parameters: { type: "object", properties: { pattern: { type: "string" }, cwd: { type: "string" } }, required: ["pattern"] } },
      { name: "grep", description: "Search for text in files", parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, caseSensitive: { type: "boolean" } }, required: ["query"] } },
      { name: "edit", description: "Edit a file by replacing text", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } }, required: ["path", "oldText", "newText"] } },
    ];

    let messages: ProviderMessage[] = initialMessages.map(toProviderMessage);
    let iteration = 0;
    let finalContent = "";

    while (iteration < (options.maxIterations ?? 10)) {
      const response = yield* Effect.mapError(
        provider.chat(messages, providerTools),
        (e) => new Error(e.message)
      );

      finalContent = response.content;

      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      console.log(`\n🔧 Iteration ${iteration + 1}: ${response.toolCalls.length} tool call(s)`);
      for (const tc of response.toolCalls) {
        console.log(`   ${tc.name}(${tc.arguments})`);
      }

      const assistantMsg: ProviderMessage = {
        role: "assistant",
        content: response.content,
        timestamp: Date.now(),
        toolCalls: response.toolCalls,
      };
      messages.push(assistantMsg);

      const toolResults = yield* Effect.all(
        response.toolCalls.map((tc) =>
          Effect.map(executeTool(tc.name, tc.arguments, sandboxToolsMap), (result) => ({ tc, result }))
        )
      );

      for (const { tc, result } of toolResults) {
        console.log(`   → ${result.content.substring(0, 100)}${result.content.length > 100 ? "..." : ""}`);
        messages.push(formatToolResultMessage(tc.id, result.content));
      }

      iteration++;
    }

    console.log(`\n📤 Output:\n${finalContent}`);
    console.log(`\n  [Iterations: ${iteration}]`);
  });

export const run = (prompt: string, options: RunOptions): void => {
  Effect.runPromise(
    doRun(prompt, options).pipe(
      Effect.catch((e: unknown) => Effect.sync(() => console.error("Error:", e)))
    )
  );
};