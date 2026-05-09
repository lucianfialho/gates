import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { stream } from "hono/streaming";
import { Effect } from "effect";
import { makeMiniMaxProvider, makeAnthropicProvider, makeOpenAIProvider } from "@gatesai/providers";
import type { Provider, Tool as ProviderTool } from "@gatesai/providers";
import { makeFileSessionStore, SessionHistory, toolsMap, listSessions } from "@gatesai/runtime";
import type { Message } from "@gatesai/runtime";
import type { Message as ProviderMessage, ToolCall } from "@gatesai/providers";
import { makeLocalSandbox } from "@gatesai/sandbox";
import { discoverSkills, makeSkillExecutor, createSandboxToolExecutor } from "@gatesai/skills";
import type { LoadedHarness } from "../harness/loader.js";
import type { HarnessConfig } from "../harness/define.js";

export const DEFAULT_PORT = 3583;
const MAX_TOOL_ITERATIONS = 10;

// ── Provider factory ─────────────────────────────────────────────────────────

function makeProvider(config: HarnessConfig): Provider {
  const apiKey =
    config.provider.apiKey ??
    process.env[`${config.provider.type.toUpperCase()}_API_KEY`] ??
    "";
  switch (config.provider.type) {
    case "anthropic": return makeAnthropicProvider({ apiKey, model: config.provider.model });
    case "openai":    return makeOpenAIProvider({ apiKey, model: config.provider.model });
    case "minimax":
    default:          return makeMiniMaxProvider({ apiKey, model: config.provider.model });
  }
}

// ── Message type bridge ───────────────────────────────────────────────────────

const toProviderMessage = (m: Message): ProviderMessage => ({
  role: (m.role === "tool" ? "user" : m.role === "context" ? "system" : m.role) as ProviderMessage["role"],
  content: m.content,
  timestamp: m.timestamp,
});

// ── Session registry ─────────────────────────────────────────────────────────

const sessions = new Map<string, { harnessName: string; createdAt: number }>();
const sse = (type: string, data: unknown): string =>
  `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

// ── App ───────────────────────────────────────────────────────────────────────

export function createServer(harnesses: LoadedHarness[]) {
  const app = new Hono();

  app.get("/api/harnesses", (c) =>
    c.json(harnesses.map((h) => ({
      name: h.name,
      description: h.config.description ?? "",
      provider: h.config.provider.type,
      model: h.config.provider.model ?? "",
      tools: h.config.tools ?? [],
    })))
  );

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json<{ harnessName?: string; resumeSessionId?: string }>();

    // Resume an existing persisted session
    if (body.resumeSessionId) {
      const store = await Effect.runPromise(makeFileSessionStore());
      const data = await Effect.runPromise(store.load(`harness-ui:${body.resumeSessionId}`));
      if (!data) return c.json({ error: "Session not found" }, 404);
      const harnessName = (data.metadata as Record<string, string>).harnessName ?? "Assistant";
      sessions.set(body.resumeSessionId, {
        harnessName,
        createdAt: new Date(data.createdAt).getTime(),
      });
      return c.json({ sessionId: body.resumeSessionId });
    }

    // New session
    const { harnessName } = body;
    if (!harnessName || !harnesses.find((h) => h.name === harnessName))
      return c.json({ error: "Harness not found" }, 404);
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { harnessName, createdAt: Date.now() });
    return c.json({ sessionId });
  });

  app.get("/api/sessions", async (c) => {
    const store = await Effect.runPromise(makeFileSessionStore());
    const keys = await Effect.runPromise(listSessions());

    const result = (
      await Promise.all(
        keys
          .filter((k) => k.startsWith("harness-ui_"))
          .map(async (key) => {
            const originalKey = key.replace(/^harness-ui_/, "harness-ui:");
            const data = await Effect.runPromise(store.load(originalKey));
            if (!data) return null;
            const meta = data.metadata as Record<string, string>;
            const sessionId = meta.sessionId ?? key.replace("harness-ui_", "");
            const msgEntries = data.entries.filter((e) => e.type === "message");
            const lastUser = [...msgEntries]
              .reverse()
              .find((e) => (e as { message?: { role: string } }).message?.role === "user") as
              | { message: { content: string } }
              | undefined;
            return {
              id: sessionId,
              harnessName: meta.harnessName ?? "Unknown",
              messageCount: msgEntries.length,
              preview: lastUser?.message.content.slice(0, 80) ?? "",
              createdAt: new Date(data.createdAt).getTime(),
              updatedAt: new Date(data.updatedAt).getTime(),
            };
          })
      )
    )
      .filter(Boolean)
      .sort((a, b) => b!.updatedAt - a!.updatedAt);

    return c.json(result);
  });

  app.delete("/api/sessions/:id", async (c) => {
    const sessionId = c.req.param("id");
    const store = await Effect.runPromise(makeFileSessionStore());
    await Effect.runPromise(store.delete(`harness-ui:${sessionId}`));
    sessions.delete(sessionId);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/chat", (c) => {
    const sessionId = c.req.param("id");
    return stream(c, async (s) => {
      const write = (type: string, data: unknown) => s.write(sse(type, data));
      try {
        const { content, role: roleOverride } = await c.req.json<{
          content: string; role?: string;
        }>();

        const meta = sessions.get(sessionId);
        if (!meta) { await write("error", { message: "Session not found" }); return; }

        const loaded = harnesses.find((h) => h.name === meta.harnessName);
        if (!loaded) { await write("error", { message: "Harness not found" }); return; }

        await write("start", { sessionId });
        await write("thinking", {});

        const provider = makeProvider(loaded.config);

        // Load persisted history
        const store = await Effect.runPromise(makeFileSessionStore());
        const storageKey = `harness-ui:${sessionId}`;
        const existing = await Effect.runPromise(store.load(storageKey));
        const history = await Effect.runPromise(SessionHistory.fromData(existing));
        const contextMessages = await Effect.runPromise(history.buildContext());

        const activeRole = roleOverride ?? loaded.config.defaultRole;
        const systemPrompt =
          loaded.config.roles?.find((r) => r.name === activeRole)?.systemPrompt ??
          loaded.config.systemPrompt ?? "You are a helpful assistant.";

        // Set up sandbox + tools (only those declared in harness config)
        const sandbox = await Effect.runPromise(makeLocalSandbox({ cwd: process.cwd() }));
        const allTools = toolsMap(sandbox);

        // Built-in fetch_url tool — always available
        allTools.set("fetch_url", {
          name: "fetch_url",
          description: "Fetch the content of a URL (GitHub pages, docs, APIs). Returns the response text.",
          parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
          execute: (params) => Effect.gen(function* () {
            const url = params["url"] as string;
            const result = yield* Effect.result(Effect.tryPromise({
              try: async () => {
                const res = await fetch(url, {
                  headers: { "User-Agent": "gates/0.1.0", "Accept": "text/html,application/json,text/plain,*/*" },
                });
                const text = await res.text();
                return text.slice(0, 8000); // limit to 8k chars
              },
              catch: (e) => new Error(String(e)),
            }));
            if (result._tag === "Failure") return { content: `Error fetching ${url}: ${result.failure.message}`, isError: true };
            return { content: result.success, metadata: { url } };
          }),
        });

        const declaredToolNames = loaded.config.tools ?? [];

        const providerTools: ProviderTool[] = [
          ...declaredToolNames.flatMap((name) => {
            const t = allTools.get(name);
            return t ? [{ name: t.name, description: t.description, parameters: t.parameters }] : [];
          }),
          // fetch_url always included
          { name: "fetch_url", description: "Fetch the content of a URL", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
        ];

        // Initial message list
        const currentMessages: ProviderMessage[] = [
          { role: "system", content: systemPrompt, timestamp: Date.now() },
          ...contextMessages.map(toProviderMessage),
          { role: "user", content, timestamp: Date.now() },
        ];

        let finalContent = "";
        let iteration = 0;

        // ── Agent loop ─────────────────────────────────────────────────────
        while (iteration < MAX_TOOL_ITERATIONS) {
          const result = await Effect.runPromise(
            provider.chat(currentMessages, providerTools.length > 0 ? providerTools : undefined)
          );
          finalContent = result.content;

          if (!result.toolCalls?.length) break;

          // Execute each tool call, streaming events as we go
          const toolResults: Array<{ tc: ToolCall; output: string; isError: boolean }> = [];

          for (const tc of result.toolCalls) {
            await write("tool_call", { id: tc.id, name: tc.name, args: tc.arguments });

            const tool = allTools.get(tc.name);
            let output: string;
            let isError = false;

            if (tool) {
              let params: Record<string, unknown> = {};
              try { params = JSON.parse(tc.arguments); } catch { params = {}; }
              const execResult = await Effect.runPromise(Effect.result(tool.execute(params)));
              if (execResult._tag === "Success") {
                output = execResult.success.content.slice(0, 2000);
                isError = execResult.success.isError ?? false;
              } else {
                output = `Tool execution failed: ${String(execResult.failure)}`;
                isError = true;
              }
            } else {
              output = `Tool "${tc.name}" not available`;
              isError = true;
            }

            await write("tool_result", { id: tc.id, name: tc.name, output, isError });
            toolResults.push({ tc, output, isError });
          }

          // Append assistant + tool results to conversation
          currentMessages.push({
            role: "assistant",
            content: result.content,
            timestamp: Date.now(),
            toolCalls: result.toolCalls,
          });
          currentMessages.push({
            role: "user",
            content: "",
            timestamp: Date.now() + 1,
            toolResults: toolResults.map(({ tc, output, isError }) => ({
              toolCallId: tc.id,
              content: output,
              isError,
            })),
          });

          iteration++;
        }

        // Persist: user message + final assistant response
        const userMsg: Message = { id: crypto.randomUUID(), role: "user", content, timestamp: Date.now() };
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: finalContent,
          timestamp: Date.now() + 1,
        };
        await Effect.runPromise(history.appendMessage(userMsg, "user"));
        await Effect.runPromise(history.appendMessage(assistantMsg, "prompt"));
        const data = await Effect.runPromise(history.toData({ sessionId, harnessName: meta.harnessName }));
        await Effect.runPromise(store.save(storageKey, data));

        // Stream final response word by word
        for (const word of finalContent.split(/(\s+)/)) {
          if (word) {
            await write("delta", { text: word });
            await new Promise((r) => setTimeout(r, 8));
          }
        }
        await write("done", { content: finalContent, usage: { totalTokens: 0 }, iterations: iteration });
      } catch (err) {
        const msg = err instanceof Error ? err.message : (typeof err === "object" && err !== null && "message" in err) ? String((err as {message:unknown}).message) : JSON.stringify(err); await write("error", { message: msg });
      }
    });
  });

  app.get("/api/sessions/:id/history", async (c) => {
    const sessionId = c.req.param("id");
    const store = await Effect.runPromise(makeFileSessionStore());
    const data = await Effect.runPromise(store.load(`harness-ui:${sessionId}`));
    if (!data) return c.json({ messages: [] });
    const history = await Effect.runPromise(SessionHistory.fromData(data));
    const messages = await Effect.runPromise(history.buildContext());
    return c.json({ messages });
  });

  // ── Skills ──────────────────────────────────────────────────────────────────

  app.get("/api/skills", async (c) => {
    const skills = await Effect.runPromise(
      Effect.result(discoverSkills(process.cwd() + "/.gates/skills"))
    );
    if (skills._tag === "Failure") return c.json([]);
    return c.json(
      skills.success.map((s) => ({
        name: s.name,
        description: s.config.description ?? "",
        initialState: s.config.initialState,
        states: s.config.states.map((st) => st.id),
      }))
    );
  });

  // Run a skill with real-time state machine event streaming
  app.post("/api/sessions/:id/skill", (c) => {
    const sessionId = c.req.param("id");
    return stream(c, async (s) => {
      const write = (type: string, data: unknown) => s.write(sse(type, data));
      try {
        const { skillName, input = {} } = await c.req.json<{
          skillName: string;
          input?: Record<string, unknown>;
        }>();

        const meta = sessions.get(sessionId);
        if (!meta) { await write("error", { message: "Session not found" }); return; }

        // Find skill config
        const allSkills = await Effect.runPromise(
          Effect.result(discoverSkills(process.cwd() + "/.gates/skills"))
        );
        if (allSkills._tag === "Failure") {
          await write("error", { message: "Failed to load skills" }); return;
        }
        const found = allSkills.success.find((s) => s.name === skillName || s.config.name === skillName);
        if (!found) {
          await write("error", { message: `Skill "${skillName}" not found` }); return;
        }

        await write("skill_start", { name: found.name, states: found.config.states.map((st) => st.id) });

        const sandbox = await Effect.runPromise(makeLocalSandbox({ cwd: process.cwd() }));
        const executorConfig = {
          ...createSandboxToolExecutor(sandbox),
          onEvent: (event: { type: string; state?: string; transition?: string; data?: unknown }) => {
            s.write(sse("skill_event", event)).catch(() => {});
          },
        };

        const executor = await Effect.runPromise(makeSkillExecutor(found.config, executorConfig));
        const ctx = await Effect.runPromise(
          Effect.result(executor.execute(input as Record<string, unknown>))
        );

        if (ctx._tag === "Failure") {
          await write("skill_error", { message: `${ctx.failure.code}: ${ctx.failure.message}` });
          return;
        }

        await write("skill_complete", {
          name: found.name,
          state: ctx.success.state,
          results: ctx.success.results,
          errors: ctx.success.errors,
          lastOutput: ctx.success.lastOutput,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : (typeof err === "object" && err !== null && "message" in err) ? String((err as {message:unknown}).message) : JSON.stringify(err); await write("error", { message: msg });
      }
    });
  });

  return app;
}

export async function startServer(
  harnesses: LoadedHarness[],
  port = DEFAULT_PORT
): Promise<() => void> {
  const app = createServer(harnesses);
  const server = serve({ fetch: app.fetch, port });
  return () => server.close();
}
