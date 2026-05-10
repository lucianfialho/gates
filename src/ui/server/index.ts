import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { stream } from "hono/streaming";
import { Effect } from "effect";
import { makeMiniMaxProvider, makeAnthropicProvider, makeOpenAIProvider, makeClaudeCodeProvider, withPacing } from "@gatesai/providers";
import type { Provider } from "@gatesai/providers";
import { makeFileSessionStore, SessionHistory, toolsMap, listSessions, createHarness, createHarnessRegistry } from "@gatesai/runtime";
import type { Message, HarnessStreamEvent, HarnessResponse } from "@gatesai/runtime";
import defaultHarnessDef, { gatesDefaultRole, GATES_BEHAVIOR_RULES } from "../harness/default.js";
import type { Message as ProviderMessage } from "@gatesai/providers";
import { makeLocalSandbox } from "@gatesai/sandbox";
import { discoverSkills, makeSkillExecutor, createSandboxToolExecutor } from "@gatesai/skills";
import type { LoadedHarness } from "../harness/loader.js";
import type { HarnessConfig } from "../harness/define.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const DEFAULT_PORT = 3583;

// ── Read ~/.gates/config.json (written by `gates login`) ─────────────────────

const GATES_CONFIG = path.join(os.homedir(), ".gates", "config.json");

function readSavedKeys(): Record<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(GATES_CONFIG, "utf-8")) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    const keys: Record<string, string> = {};
    for (const [provider, cfg] of Object.entries(data.providers ?? {})) {
      if (cfg.apiKey) keys[provider] = cfg.apiKey;
    }
    return keys;
  } catch {
    return {};
  }
}

// ── Known models per provider ────────────────────────────────────────────────

export const KNOWN_MODELS: Record<string, Array<{ id: string; label: string; tier: "fast" | "balanced" | "powerful" }>> = {
  anthropic: [
    { id: "claude-opus-4-7",         label: "Claude Opus 4.7",     tier: "powerful" },
    { id: "claude-sonnet-4-6",       label: "Claude Sonnet 4.6",   tier: "balanced" },
    { id: "claude-haiku-4-5",        label: "Claude Haiku 4.5",    tier: "fast" },
  ],
  openai: [
    { id: "o3",           label: "o3",           tier: "powerful" },
    { id: "gpt-4o",       label: "GPT-4o",       tier: "balanced" },
    { id: "gpt-4o-mini",  label: "GPT-4o mini",  tier: "fast" },
  ],
  minimax: [
    { id: "MiniMax-M2.7",  label: "MiniMax M2.7",  tier: "balanced" },
  ],
};

export interface ModelSlot {
  role: "planning" | "execution" | "review";
  label: string;
  description: string;
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
}

const DEFAULT_MODEL_SLOTS: ModelSlot[] = [
  {
    role: "planning",
    label: "Planning",
    description: "Deep reasoning for complex tasks — architecture, strategy, design",
    provider: "anthropic", model: "claude-opus-4-7",
    defaultProvider: "anthropic", defaultModel: "claude-opus-4-7",
  },
  {
    role: "execution",
    label: "Execution",
    description: "Balanced speed/quality — implements, writes code, runs pipelines",
    provider: "anthropic", model: "claude-sonnet-4-6",
    defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-6",
  },
  {
    role: "review",
    label: "Review",
    description: "Fast and cheap — code review, quick feedback, validation",
    provider: "anthropic", model: "claude-haiku-4-5",
    defaultProvider: "anthropic", defaultModel: "claude-haiku-4-5",
  },
];

function readModelSlots(): ModelSlot[] {
  try {
    const data = JSON.parse(fs.readFileSync(GATES_CONFIG, "utf-8")) as { models?: Record<string, { provider: string; model: string }> };
    const saved = data.models ?? {};
    return DEFAULT_MODEL_SLOTS.map((slot) => ({
      ...slot,
      provider: saved[slot.role]?.provider ?? slot.defaultProvider,
      model: saved[slot.role]?.model ?? slot.defaultModel,
    }));
  } catch {
    return DEFAULT_MODEL_SLOTS;
  }
}

// ── Provider factory ─────────────────────────────────────────────────────────

function makeProvider(config: HarnessConfig): Provider {
  const saved = readSavedKeys();
  const providerType = config.provider.type ?? "minimax";

  const apiKey =
    config.provider.apiKey ??
    process.env[`${providerType.toUpperCase()}_API_KEY`] ??
    saved[providerType] ??
    "";

  if (!apiKey) {
    console.warn(
      `[gates] No API key for provider "${providerType}". ` +
      `Run: gates login --provider ${providerType} --key YOUR_KEY`
    );
  }

  switch (providerType) {
    case "anthropic": return makeAnthropicProvider({ apiKey, model: config.provider.model });
    case "openai":    return makeOpenAIProvider({ apiKey, model: config.provider.model });
    case "minimax":
    default:          return makeMiniMaxProvider({ apiKey, model: config.provider.model });
  }
}

// ── Pick best available provider ─────────────────────────────────────────────

function pickBestProvider(
  tools: Map<string, import("@gatesai/runtime").Tool>,
  connectorDocs: string
): import("@gatesai/providers").Provider {
  const saved = readSavedKeys();
  const slots = readModelSlots();

  const providerType = (process.env.ANTHROPIC_API_KEY ?? saved["anthropic"]) ? "anthropic"
    : (process.env.MINIMAX_API_KEY ?? saved["minimax"]) ? "minimax"
    : (process.env.OPENAI_API_KEY ?? saved["openai"]) ? "openai"
    : "minimax";

  const apiKey =
    process.env[`${providerType.toUpperCase()}_API_KEY`] ??
    saved[providerType] ??
    "";

  if (!apiKey) {
    console.warn(
      `[gates] No API key for provider "${providerType}". ` +
      `Run: gates login --provider ${providerType} --key YOUR_KEY`
    );
  }

  const executionSlot = slots.find((s) => s.role === "execution");
  const model = executionSlot?.provider === providerType ? executionSlot.model : undefined;

  // Use ClaudeCodeProvider when Anthropic OAuth token is configured.
  // It spawns `claude -p` which uses subscription routing — no API rate limits.
  // Falls back to direct API for non-OAuth keys (sk-ant-api) or other providers.
  const isOAuthToken = providerType === "anthropic" && apiKey.startsWith("sk-ant-oat");
  if (isOAuthToken) {
    return makeClaudeCodeProvider({ model: model ?? "claude-sonnet-4-6" });
  }

  let base: Provider;
  switch (providerType) {
    case "anthropic": base = makeAnthropicProvider({ apiKey, model }); break;
    case "openai":    base = makeOpenAIProvider({ apiKey, model }); break;
    case "minimax":
    default:          base = makeMiniMaxProvider({ apiKey, model }); break;
  }
  return withPacing(base, { maxConcurrent: 3, minIntervalMs: 300, maxRetries: 5 });
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

// ── Server-level loaded connectors & tools ────────────────────────────────────

interface ServerToolState {
  // allTools: sandbox tools + connector tools + fetch_url, built per provider config
  connectorTools: Map<string, import("@gatesai/runtime").Tool>;
  connectorDocs: string;
}

async function loadServerTools(): Promise<ServerToolState> {
  const saved = readSavedKeys();
  const credentials = {
    GH_TOKEN: process.env.GH_TOKEN ?? saved["github"] ?? "",
    GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:
      process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE ?? saved["google-workspace"] ?? "",
  };

  const connectorTools: Map<string, import("@gatesai/runtime").Tool> = new Map();
  const allDocs: string[] = [];

  try {
    const { loadConnectors } = await import("@gatesai/skills");
    const connectorPaths = [
      path.join(os.homedir(), ".gates", "connectors"),   // global — always loaded
      path.join(process.cwd(), ".gates", "connectors"),  // project-level
    ];

    for (const dir of connectorPaths) {
      const result = await Effect.runPromise(Effect.result(loadConnectors(dir, credentials)));
      if (result._tag === "Success") {
        for (const [name, tool] of result.success.allTools()) {
          connectorTools.set(name, tool);
        }
        const docs = result.success.allDocs();
        if (docs.trim()) allDocs.push(docs);
      }
    }
  } catch { /* connectors optional */ }

  const combined = allDocs.join("\n\n---\n\n");
  const connectorDocs = combined.trim() ? `\n\n## Tool Reference\n\n${combined}` : "";

  return { connectorTools, connectorDocs };
}

// ── Build runtime HarnessConfig from gates YAML-style config ─────────────────

function buildRuntimeHarnessConfig(
  gatesConfig: HarnessConfig,
  provider: Provider,
  allTools: Map<string, import("@gatesai/runtime").Tool>,
  declaredToolNames: string[],
  isDefaultSession: boolean,
) {
  const toolsToExpose = isDefaultSession
    ? [...allTools.keys()]
    : [...declaredToolNames, "fetch_url"];

  const sessionTools: Map<string, import("@gatesai/runtime").Tool> = new Map(
    toolsToExpose.flatMap((name) => {
      const t = allTools.get(name);
      return t ? [[name, t]] : [];
    })
  );

  const roles: import("@gatesai/runtime").Role[] = gatesConfig.roles?.map((r) => ({
    name: r.name,
    systemPrompt: r.systemPrompt,
    model: r.model,
  })) ?? [];

  const defaultSystemPrompt =
    gatesConfig.systemPrompt ?? "You are a helpful assistant.";

  if (roles.length === 0 || !roles.find((r) => r.name === "default")) {
    roles.push({ name: "default", systemPrompt: defaultSystemPrompt });
  }

  return createHarness({
    provider: {
      chat: (messages, tools) =>
        Effect.mapError(
          provider.chat(
            messages.map((m) => ({
              role: (m.role === "tool" ? "user" : m.role === "context" ? "system" : m.role) as ProviderMessage["role"],
              content: m.content,
              timestamp: m.timestamp,
            })),
            tools
          ),
          (e) => ({ code: e.code, message: e.message })
        ),
    },
    tools: sessionTools,
    maxToolIterations: 10,
    roles,
  });
}

// ── App ───────────────────────────────────────────────────────────────────────

export function createServer(harnesses: LoadedHarness[], serverTools?: ServerToolState) {
  const app = new Hono();

  // ── Harness registry (rebuilt per request so live config changes are picked up) ──
  const getRegistry = (allTools: Map<string, import("@gatesai/runtime").Tool>) => {
    const provider = pickBestProvider(allTools, serverTools?.connectorDocs ?? "");
    const registry = createHarnessRegistry({
      provider,
      tools: allTools,
      roles: [gatesDefaultRole],
      systemPromptSuffix: serverTools?.connectorDocs ?? "",
    });
    // Register built-in default harness
    registry.register("__default__", defaultHarnessDef as import("@gatesai/runtime").FunctionalHarnessDef);
    // Register any functional harnesses discovered from .gates/harnesses/
    for (const h of harnesses) {
      if (h.def) registry.register(h.name, h.def as import("@gatesai/runtime").FunctionalHarnessDef);
    }
    return registry;
  };

  // Default session — creates a session with the smart default harness
  app.post("/api/default-session", async (c) => {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { harnessName: "__default__", createdAt: Date.now() });
    return c.json({ sessionId, harnessName: "Gates" });
  });

  // Model configuration
  app.get("/api/config/models", (c) =>
    c.json({ slots: readModelSlots(), knownModels: KNOWN_MODELS })
  );

  // Project context — cwd + git repo for /code-review auto-detection
  app.get("/api/context", async (c) => {
    const cwd = process.cwd();
    let repo: string | null = null;
    try {
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const exec = promisify(execFile);
      const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd, timeout: 3000 });
      const url = stdout.trim();
      // Extract owner/repo from https://github.com/owner/repo.git or git@github.com:owner/repo.git
      const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) repo = match[1] ?? null;
    } catch { /* no git or no remote */ }
    return c.json({ cwd, repo });
  });

  // First launch detection — returns true once, then marks as seen
  app.get("/api/first-launch", (c) => {
    const existing = (() => {
      try { return JSON.parse(fs.readFileSync(GATES_CONFIG, "utf-8")); }
      catch { return {}; }
    })();

    const isFirst = existing._onboarded !== true;

    if (isFirst) {
      existing._onboarded = true;
      fs.mkdirSync(path.dirname(GATES_CONFIG), { recursive: true });
      fs.writeFileSync(GATES_CONFIG, JSON.stringify(existing, null, 2));
    }

    return c.json({ firstLaunch: isFirst });
  });

  // Detect CLI tools — runs actual commands to check install + auth state
  app.get("/api/connectors/status", async (c) => {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const check = async (cmd: string, args: string[]): Promise<{ ok: boolean; output: string }> => {
      try {
        const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 5000 });
        return { ok: true, output: (stdout + stderr).trim() };
      } catch (e) {
        return { ok: false, output: String((e as { message?: string }).message ?? e) };
      }
    };

    // gh — GitHub CLI
    const ghWhich = await check("which", ["gh"]).catch(() => ({ ok: false, output: "" }));
    const ghVersion = ghWhich.ok
      ? await check("gh", ["--version"])
      : { ok: false, output: "" };
    const ghAuth = ghWhich.ok
      ? await check("gh", ["auth", "status"])
      : { ok: false, output: "" };

    const ghUser = ghAuth.ok
      ? (ghAuth.output.match(/Logged in to .+ account (.+?) \(/)?.[1] ?? "authenticated")
      : null;

    // gws — Google Workspace CLI (may need musl binary on older Linux)
    const gwsWhich = await check("which", ["gws"]).catch(() => ({ ok: false, output: "" }));
    let gwsInstalled = false;
    let gwsCompatible = false;
    let gwsVersion = { ok: false, output: "" };
    let gwsAuth = { ok: false, output: "" };
    let gwsError: "not_installed" | "incompatible" | "not_authenticated" | null = null;

    if (gwsWhich.ok) {
      gwsVersion = await check("gws", ["--version"]);
      if (gwsVersion.output.includes("GLIBC") || gwsVersion.output.includes("libc.so")) {
        // Try to auto-fix by replacing with musl binary
        const autoFixed = await (async () => {
          try {
            const { execFile: ef } = await import("child_process");
            const { promisify: prom } = await import("util");
            const efAsync = prom(ef);
            // Find the gws package dir
            const { stdout: gwsPath } = await efAsync("which", ["gws"]);
            const { readlink } = await import("fs/promises");
            let binPath = gwsPath.trim();
            try { binPath = await readlink(binPath); } catch { /* not a symlink */ }
            const pkgDir = path.dirname(path.dirname(binPath));
            const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8")) as { version: string };
            const version = pkgJson.version;
            const artifact = `google-workspace-cli-x86_64-unknown-linux-musl.tar.gz`;
            const url = `https://github.com/googleworkspace/cli/releases/download/v${version}/${artifact}`;
            // Download and replace
            await efAsync("bash", ["-c",
              `curl -sL "${url}" | tar -xz -C /tmp/gws-musl-fix --strip-components=0 2>/dev/null || mkdir -p /tmp/gws-musl-fix && curl -sL "${url}" -o /tmp/gws-musl.tgz && tar -xzf /tmp/gws-musl.tgz -C /tmp/gws-musl-fix`
            ], { timeout: 15000 });
            await efAsync("bash", ["-c",
              `cp /tmp/gws-musl-fix/gws "${path.join(pkgDir, "bin", "gws")}" && chmod +x "${path.join(pkgDir, "bin", "gws")}"`
            ]);
            return true;
          } catch { return false; }
        })();
        if (autoFixed) {
          gwsVersion = await check("gws", ["--version"]);
        }
        if (!gwsVersion.ok || gwsVersion.output.includes("GLIBC")) {
          gwsInstalled = true;
          gwsCompatible = false;
          gwsError = "incompatible";
        } else {
          gwsInstalled = true;
          gwsCompatible = true;
          gwsAuth = await check("gws", ["auth", "status"]);
          if (!gwsAuth.ok) gwsError = "not_authenticated";
        }
      } else if (gwsVersion.ok) {
        gwsInstalled = true;
        gwsCompatible = true;
        gwsAuth = await check("gws", ["auth", "status"]);
        if (!gwsAuth.ok) gwsError = "not_authenticated";
      }
    } else {
      gwsError = "not_installed";
    }

    // Check if googleapis npm fallback is available
    const googleapisAvailable = await check("node", ["-e", "require('googleapis')"]).then((r) => r.ok).catch(() => false);

    return c.json({
      connectors: [
        {
          id: "github",
          label: "GitHub CLI (gh)",
          installed: ghWhich.ok,
          authenticated: ghAuth.ok,
          user: ghUser,
          version: ghWhich.ok ? ghVersion.output.split("\n")[0] : null,
          installCmd: "brew install gh  # or: https://cli.github.com",
          authCmd: "gh auth login",
          description: "Create and manage GitHub issues and PRs",
        },
        {
          id: "google-workspace",
          label: "Google Workspace",
          installed: gwsInstalled,
          authenticated: gwsAuth.ok,
          compatible: gwsCompatible,
          error: gwsError,
          fallbackAvailable: googleapisAvailable,
          user: null,
          version: gwsWhich.ok ? gwsVersion.output.split("\n")[0] : null,
          installCmd: "npm install -g @googleworkspace/cli",
          authCmd: "gws auth login",
          fallbackInstallCmd: "npm install googleapis  # Node.js fallback (no binary needed)",
          fallbackAuthNote: "Then set GOOGLE_CREDENTIALS_PATH=~/.gates/google-credentials.json",
          description: "Access Google Calendar, Meet transcripts and Drive",
        },
      ],
    });
  });

  // Auth status — shows all configurable items and their state
  app.get("/api/auth/status", (c) => {
    const saved = readSavedKeys();
    return c.json({
      providers: ["anthropic", "minimax", "openai"].map((p) => ({
        id: p,
        label: p === "anthropic" ? "Anthropic" : p === "minimax" ? "MiniMax" : "OpenAI",
        envVar: `${p.toUpperCase()}_API_KEY`,
        configured: !!(process.env[`${p.toUpperCase()}_API_KEY`] ?? saved[p]),
        source: process.env[`${p.toUpperCase()}_API_KEY`] ? "env" : saved[p] ? "config" : "none",
      })),
    });
  });

  // Save config item — writes to ~/.gates/config.json
  app.post("/api/config", async (c) => {
    const body = await c.req.json<{
      section: "providers" | "connectors" | "models";
      id: string;
      value: string | { provider: string; model: string };
    }>();
    const { section, id, value } = body;

    const existing = (() => {
      try { return JSON.parse(fs.readFileSync(GATES_CONFIG, "utf-8")); }
      catch { return { providers: {} }; }
    })();

    if (section === "providers") {
      existing.providers ??= {};
      existing.providers[id] = { ...(existing.providers[id] ?? {}), apiKey: value };
    } else if (section === "models") {
      existing.models ??= {};
      existing.models[id] = value; // { provider, model }
    } else {
      existing.connectors ??= {};
      existing.connectors[id] = value;
    }

    fs.mkdirSync(path.dirname(GATES_CONFIG), { recursive: true });
    fs.writeFileSync(GATES_CONFIG, JSON.stringify(existing, null, 2));
    return c.json({ ok: true });
  });

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

        await write("start", { sessionId });
        await write("thinking", {});

        // Build sandbox + allTools (sandbox builtins + server-loaded connectors + fetch_url)
        const sandbox = await Effect.runPromise(makeLocalSandbox({ cwd: process.cwd() }));
        const allTools: Map<string, import("@gatesai/runtime").Tool> = new Map(toolsMap(sandbox));

        // Merge connector tools loaded at server init
        if (serverTools) {
          for (const [name, tool] of serverTools.connectorTools) {
            allTools.set(name, tool);
          }
        }

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
                return text.slice(0, 8000);
              },
              catch: (e) => new Error(String(e)),
            }));
            if (result._tag === "Failure") return { content: `Error fetching ${url}: ${result.failure.message}`, isError: true };
            return { content: result.success, metadata: { url } };
          }),
        });

        // Load persisted history
        const store = await Effect.runPromise(makeFileSessionStore());
        const storageKey = `harness-ui:${sessionId}`;
        const existing = await Effect.runPromise(store.load(storageKey));
        const sessionHistory = await Effect.runPromise(SessionHistory.fromData(existing));
        const contextMessages = await Effect.runPromise(sessionHistory.buildContext());

        const initialHistory: Message[] = contextMessages.map((m) => ({
          id: crypto.randomUUID(),
          role: (m.role === "tool" ? "tool" : m.role === "context" ? "context" : m.role) as Message["role"],
          content: m.content,
          timestamp: m.timestamp,
        }));

        const onEvent = (e: HarnessStreamEvent) => { write(e.type, e).catch(() => {}); };

        let finalContent: string;
        let iterations: number;

        const saved = readSavedKeys();
        const env: Record<string, string> = {
          GITHUB_TOKEN: process.env.GH_TOKEN ?? saved["github"] ?? "",
          GH_TOKEN: process.env.GH_TOKEN ?? saved["github"] ?? "",
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? saved["anthropic"] ?? "",
          OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? saved["openai"] ?? "",
          MINIMAX_API_KEY: process.env.MINIMAX_API_KEY ?? saved["minimax"] ?? "",
        };

        const loadedHarness = harnesses.find((h) => h.name === meta.harnessName);
        const isFunctional = meta.harnessName === "__default__" || loadedHarness?.def != null;

        if (isFunctional) {
          // ── Functional harness: route through registry ────────────────────
          const registry = getRegistry(allTools);
          const harnessName = meta.harnessName === "__default__" ? "__default__" : meta.harnessName;
          const response = await Effect.runPromise(
            registry.run(harnessName, { message: content }, env, { onEvent, initialHistory })
          ) as HarnessResponse;

          finalContent = response.content;
          iterations = response.iterations ?? 0;
        } else {
          // ── YAML-config harness: existing path ────────────────────────────
          const harnessConfig: HarnessConfig =
            loadedHarness?.config
            ?? { name: "Assistant", provider: { type: "minimax" }, tools: [] };

          const declaredToolNames = harnessConfig.tools ?? [];
          const activeRole = roleOverride ?? harnessConfig.defaultRole ?? "default";

          const systemPrompt =
            harnessConfig.roles?.find((r) => r.name === activeRole)?.systemPrompt ??
            harnessConfig.systemPrompt ?? "You are a helpful assistant.";

          const provider = makeProvider(harnessConfig);

          const harnessInst = buildRuntimeHarnessConfig(
            { ...harnessConfig, systemPrompt },
            provider,
            allTools,
            declaredToolNames,
            false,
          );

          const session = await Effect.runPromise(
            harnessInst.init({ role: activeRole, initialHistory })
          );

          const response = await Effect.runPromise(
            session.prompt(content, { onEvent })
          );

          finalContent = response.content;
          iterations = response.iterations ?? 0;

          // Force-summary for named harnesses too
          if (!finalContent.trim() && iterations > 0) {
            await write("thinking", {});
            const summaryMessages: ProviderMessage[] = [
              { role: "system", content: systemPrompt, timestamp: Date.now() },
              ...contextMessages.map(toProviderMessage),
              { role: "user", content, timestamp: Date.now() },
            ];
            const summaryResult = await Effect.runPromise(Effect.result(provider.chat(summaryMessages)));
            if (summaryResult._tag === "Success") finalContent = summaryResult.success.content;
          }
        }

        // ── Force-summary for default harness ────────────────────────────────
        if (!finalContent.trim() && iterations > 0 && meta.harnessName === "__default__") {
          await write("thinking", {});
          const summaryProvider = pickBestProvider(allTools, serverTools?.connectorDocs ?? "");
          const summaryMessages: ProviderMessage[] = [
            { role: "system", content: GATES_BEHAVIOR_RULES + (serverTools?.connectorDocs ?? ""), timestamp: Date.now() },
            ...contextMessages.map(toProviderMessage),
            { role: "user", content, timestamp: Date.now() },
          ];
          const summaryResult = await Effect.runPromise(Effect.result(summaryProvider.chat(summaryMessages)));
          if (summaryResult._tag === "Success") finalContent = summaryResult.success.content;
        }

        // Persist the new user + assistant pair to the file store
        const userMsg: Message = {
          id: crypto.randomUUID(),
          role: "user",
          content,
          timestamp: Date.now(),
        };
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: finalContent,
          timestamp: Date.now() + 1,
        };
        await Effect.runPromise(sessionHistory.appendMessage(userMsg, "user"));
        await Effect.runPromise(sessionHistory.appendMessage(assistantMsg, "prompt"));
        const data = await Effect.runPromise(
          sessionHistory.toData({ sessionId, harnessName: meta.harnessName })
        );
        await Effect.runPromise(store.save(storageKey, data));

        // Stream final response word by word (fake delta streaming)
        for (const word of finalContent.split(/(\s+)/)) {
          if (word) {
            await write("delta", { text: word });
            await new Promise((r) => setTimeout(r, 8));
          }
        }
        await write("done", { content: finalContent, usage: { totalTokens: 0 }, iterations });
      } catch (err) {
        const msg = err instanceof Error ? err.message : (typeof err === "object" && err !== null && "message" in err) ? String((err as {message:unknown}).message) : JSON.stringify(err);
        await write("error", { message: msg });
      }
    });
  });

  // ── Code Review — dedicated endpoint ────────────────────────────────────────
  // Runs the code-review harness directly, streaming kanban_update + tool_call events.

  app.post("/api/code-review", (c) => {
    return stream(c, async (s) => {
      const write = (type: string, data: unknown) => s.write(sse(type, data));
      try {
        const { path: reviewPath = ".", repo, focus, maxIssues = 5, dryRun = false, model: reviewModel } =
          await c.req.json<{ path?: string; repo?: string; focus?: string; maxIssues?: number; dryRun?: boolean; model?: string }>();

        if (!repo) { await write("error", { message: "repo is required" }); return; }

        const codeReviewHarness = harnesses.find((h) => h.name === "Code Review");
        if (!codeReviewHarness?.def) {
          await write("error", {
            message: "Code Review harness não encontrado. Rode gates dentro de um projeto com .gates/harnesses/code-review/",
          });
          return;
        }

        await write("start", { path: reviewPath, repo });

        const sandbox = await Effect.runPromise(makeLocalSandbox({ cwd: process.cwd() }));
        const allTools: Map<string, import("@gatesai/runtime").Tool> = new Map(toolsMap(sandbox));
        if (serverTools) {
          for (const [name, tool] of serverTools.connectorTools) allTools.set(name, tool);
        }

        const saved = readSavedKeys();
        const env: Record<string, string> = {
          GITHUB_TOKEN: process.env.GH_TOKEN ?? saved["github"] ?? "",
          GH_TOKEN:     process.env.GH_TOKEN ?? saved["github"] ?? "",
        };

        // Build review-specific registry.
        // If model is specified, override the provider — supports haiku/minimax for faster streaming.
        // haiku:  cheaper, higher rate limits, explicit tool loop (delta events per step)
        // minimax: no OAuth rate limits
        // claude-code (default): subprocess, subscription routing
        const reviewRegistry = (() => {
          const { loadConnectors: _lc, ..._ } = {} as Record<string, unknown>; void _lc; void _;
          let reviewProvider: Provider = pickBestProvider(allTools, serverTools?.connectorDocs ?? "");

          if (reviewModel) {
            const apiKey = process.env["ANTHROPIC_API_KEY"] ?? saved["anthropic"] ?? "";
            const mmKey  = process.env["MINIMAX_API_KEY"]   ?? saved["minimax"]   ?? "";
            if (reviewModel.startsWith("claude-haiku") || reviewModel.startsWith("claude-sonnet") || reviewModel.startsWith("claude-opus")) {
              reviewProvider = withPacing(makeAnthropicProvider({ apiKey, model: reviewModel }), { maxConcurrent: 2, minIntervalMs: 500, maxRetries: 5 });
            } else if (reviewModel === "minimax" || reviewModel.startsWith("MiniMax")) {
              reviewProvider = withPacing(makeMiniMaxProvider({ apiKey: mmKey, model: reviewModel === "minimax" ? undefined : reviewModel }), { maxConcurrent: 2, minIntervalMs: 500, maxRetries: 3 });
            }
          }

          const reg = createHarnessRegistry({
            provider: reviewProvider,
            tools: allTools,
            systemPromptSuffix: serverTools?.connectorDocs ?? "",
          });
          reg.register(codeReviewHarness.name, codeReviewHarness.def as import("@gatesai/runtime").FunctionalHarnessDef);
          return reg;
        })();

        const onEvent = (e: HarnessStreamEvent) => { write(e.type, e).catch(() => {}); };

        const result = await Effect.runPromise(
          reviewRegistry.run(codeReviewHarness.name, { path: reviewPath, repo, focus, maxIssues, dryRun }, env, { onEvent })
        );

        await write("done", { result });
      } catch (err) {
        // HarnessError is a plain object { code, message } — not an Error instance
        const msg = err instanceof Error
          ? err.message
          : (err as Record<string, unknown>)?.message as string
            ?? JSON.stringify(err);
        await write("error", { message: msg });
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
        const msg = err instanceof Error ? err.message : (typeof err === "object" && err !== null && "message" in err) ? String((err as {message:unknown}).message) : JSON.stringify(err);
        await write("error", { message: msg });
      }
    });
  });

  return app;
}

export async function startServer(
  harnesses: LoadedHarness[],
  port = DEFAULT_PORT
): Promise<() => void> {
  // Load connector tools once at server startup
  const serverTools = await loadServerTools();
  console.log(`[gates] Loaded ${serverTools.connectorTools.size} connector tool(s)`);

  const app = createServer(harnesses, serverTools);
  const server = serve({ fetch: app.fetch, port });
  return () => server.close();
}
