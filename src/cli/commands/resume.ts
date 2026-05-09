import { Effect } from "effect";
import { getProviderConfig, type ProviderType } from "../providers/index.js";
import { makeMiniMaxProvider, makeAnthropicProvider, makeOpenAIProvider } from "@gatesai/providers";
import type { Provider, Message as ProviderMessage } from "@gatesai/providers";
import { makeFileSessionStore, SessionHistory } from "@gatesai/runtime";
import type { Message } from "@gatesai/runtime";

interface ResumeOptions {
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

const doResume = (sessionId: string, prompt: string, options: ResumeOptions): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { apiKey, model: configModel } = getProviderConfig(options.provider);

    if (!apiKey) {
      console.error(`Missing API key. Run 'gates connect' first.`);
      return;
    }

    const model = options.model ?? configModel;
    const provider = createProvider(options.provider, apiKey, model);

    const store = yield* makeFileSessionStore();
    const storageKey = `chat:${sessionId}`;

    const existingData = yield* store.load(storageKey);
    const history = yield* SessionHistory.fromData(existingData);

    if (!existingData) {
      console.error(`Session "${sessionId}" not found. Use 'gates chat --session ${sessionId}' to start a new session.`);
      return;
    }

    const existingMsgCount = existingData.entries.filter((e) => e.type === "message").length;
    console.log(`Resuming session "${sessionId}" (${existingMsgCount} messages loaded)\n`);

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
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

      const data = yield* history.toData({ sessionId });
      yield* store.save(storageKey, data);

      console.log(response.success.content);
      console.log(`\n  [Tokens: ${response.success.usage.totalTokens}]`);
      console.log(`  [Session updated: ${sessionId}]`);
    } else {
      const e = response.failure as { message?: string };
      console.error(`Error: ${e.message ?? response.failure}`);
    }
  });

export const resume = (sessionId: string, prompt: string, options: ResumeOptions): void => {
  Effect.runPromise(doResume(sessionId, prompt, options));
};