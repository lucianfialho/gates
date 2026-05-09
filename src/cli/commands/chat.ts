import { Effect, Ref } from "effect";
import * as readline from "readline";
import { getProviderConfig, type ProviderType } from "../providers/index.js";
import { makeMiniMaxProvider, makeAnthropicProvider, makeOpenAIProvider } from "@gatesai/providers";
import type { Provider, Message as ProviderMessage } from "@gatesai/providers";
import { makeFileSessionStore, SessionHistory } from "@gatesai/runtime";
import type { Message } from "@gatesai/runtime";

interface ChatOptions {
  session?: string;
  provider: ProviderType;
  model?: string;
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

const toProviderMessage = (msg: Message): ProviderMessage => ({
  role: msg.role as "user" | "assistant" | "system" | "context",
  content: msg.content,
  timestamp: msg.timestamp,
});

const doChat = (options: ChatOptions): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { apiKey, model: configModel } = getProviderConfig(options.provider);
    if (!apiKey) {
      console.error(`Missing API key. Run 'gates connect' first.`);
      return;
    }

    const model = options.model ?? configModel;
    const provider = createProvider(options.provider, apiKey, model);
    const sessionId = options.session ?? "default";

    console.log(`\n🜂 Gates Effect Chat`);
    console.log(`Provider: ${options.provider}`);
    console.log(`Model: ${model ?? "default"}`);
    console.log(`Session: ${sessionId}`);
    console.log(`Type 'exit' to quit, 'clear' to reset session\n`);
    console.log("─".repeat(40));

    const store = yield* makeFileSessionStore();
    const storageKey = `chat:${sessionId}`;

    const existingData = yield* store.load(storageKey);
    const history = yield* SessionHistory.fromData(existingData);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\nYou: ",
    });

    const readLineEffect = (): Effect.Effect<string> =>
      Effect.promise(() => new Promise<string>((resolve) => {
        rl.once("line", (line) => resolve(line));
      }));

    const persist = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const data = yield* history.toData({ sessionId });
        yield* store.save(storageKey, data);
      });

    const chatLoop = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const line: string = yield* readLineEffect();
        const input = line.trim();

        if (input === "exit" || input === "quit") {
          yield* persist();
          rl.close();
          console.log("\nSession saved.");
          return;
        }

        if (input === "clear") {
          const freshHistory = yield* SessionHistory.empty();
          const data = yield* freshHistory.toData({ sessionId });
          yield* store.save(storageKey, data);
          console.log("Session cleared.");
          rl.prompt();
          return yield* chatLoop();
        }

        if (!input) {
          rl.prompt();
          return yield* chatLoop();
        }

        process.stdout.write("\nAgent: ");

        const userMessage: Message = {
          id: crypto.randomUUID(),
          role: "user",
          content: input,
          timestamp: Date.now(),
        };

        yield* history.appendMessage(userMessage, "user");

        const contextMessages = yield* history.buildContext();
        const providerMessages = contextMessages.map(toProviderMessage);

        const response = yield* Effect.result(provider.chat(providerMessages));

        if (response._tag === "Success") {
          const assistantMessage: Message = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: response.success.content,
            timestamp: Date.now(),
          };

          yield* history.appendMessage(assistantMessage, "prompt");

          console.log(`\n${response.success.content}`);
          console.log(`  [Tokens: ${response.success.usage.totalTokens}]`);

          yield* persist();
        } else {
          const err = response.failure as { message?: string };
          console.log(`\n❌ Error: ${err.message ?? response.failure}`);
        }

        rl.prompt();
        return yield* chatLoop();
      });

    yield* chatLoop();
  });

export const chat = (options: ChatOptions): void => {
  const providerName = options.provider ?? "minimax";
  Effect.runPromise(doChat({ ...options, provider: providerName }));
};