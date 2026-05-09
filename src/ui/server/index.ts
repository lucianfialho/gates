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
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const DEFAULT_PORT = 3583;
const MAX_TOOL_ITERATIONS = 10;

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

// ── Smart default harness ─────────────────────────────────────────────────────

async function buildDefaultHarness(): Promise<HarnessConfig> {
  const saved = readSavedKeys();

  // Pick best available provider
  const providerType = process.env.ANTHROPIC_API_KEY ?? saved["anthropic"] ? "anthropic"
    : process.env.MINIMAX_API_KEY ?? saved["minimax"] ? "minimax"
    : process.env.OPENAI_API_KEY ?? saved["openai"] ? "openai"
    : "minimax";

  // Detect configured connectors to build capabilities section
  const { execFile: ef } = await import("child_process");
  const { promisify } = await import("util");
  const exec = promisify(ef);
  const tryCmd = async (cmd: string, args: string[]) => {
    try { await exec(cmd, args, { timeout: 3000 }); return true; } catch { return false; }
  };

  const ghReady = await tryCmd("gh", ["auth", "status"]);
  const gwsReady = await tryCmd("gws", ["auth", "status"]);

  const capabilities: string[] = [];

  if (ghReady) {
    capabilities.push(`### GitHub
- Create issues, PRs, review code, manage repos via the gh CLI
- Trigger when: user mentions issues, tickets, bugs, tasks, pull requests, code review

EXACT tools to use:
  Create issue: gh with args="issue create --repo OWNER/REPO --title '...' --body '...'"
  List issues:  gh with args="issue list --repo OWNER/REPO"
  Create PR:    gh with args="pr create --repo OWNER/REPO --title '...' --body '...'"

When user asks to create tickets/issues:
  1. IMMEDIATELY call gh to create the issue — never ask the user to run commands
  2. Use the repo from context or ask ONCE for the repo name`);
  }

  if (gwsReady) {
    capabilities.push(`### Google Meet & Calendar
- List recent meetings, fetch full transcripts, get participants
- Trigger when: user mentions meetings, standups, transcripts, reuniões, Q&A

EXACT tools to use (call these directly, do NOT ask the user to run commands):
  List meetings:      gws_meet with args="meet conferenceRecords list"
  Get transcript:     gws_meet with args="meet conferenceRecords transcripts entries list --params '{\"parent\":\"conferenceRecords/ID/transcripts/TRANSCRIPT_ID\"}'"
  Get transcript IDs: gws_meet with args="meet conferenceRecords transcripts list --params '{\"parent\":\"conferenceRecords/RECORD_ID\"}'"
  List participants:  gws_meet with args="meet conferenceRecords participants list --params '{\"parent\":\"conferenceRecords/RECORD_ID\"}'"

When user asks about meetings:
  1. IMMEDIATELY call gws_meet to list conferenceRecords — never ask for auth or credentials
  2. Filter results by date/topic based on user's request
  3. Fetch transcript for matching meetings
  4. Present results conversationally`);
  }

  capabilities.push(`### Code & Files
- Read, write, search, edit files in the project
- Trigger when: user asks about code, files, implementation, debugging`);

  const capSection = capabilities.length > 0
    ? `## What you can do\n\n${capabilities.join("\n\n")}`
    : `## What you can do\n\nYou can read, write, search and edit files in this project.`;

  // Inject gws guide if available
  let gwsGuide = "";
  if (gwsReady) {
    const guidePaths = [
      `${process.cwd()}/.gates/docs/gws-guide.md`,
      `${os.homedir()}/gates-effect/.gates/docs/gws-guide.md`,
    ];
    for (const p of guidePaths) {
      try {
        gwsGuide = "\n\n" + fs.readFileSync(p, "utf-8");
        break;
      } catch { /* not found */ }
    }
  }

  // Few-shot examples from real failure patterns in session logs
  const fewShot = gwsReady ? `
## Critical: How to respond to meeting requests

❌ WRONG (never do this):
User: "puxa as reuniões de sexta"
Agent: "Não tenho acesso ao Google Calendar neste ambiente..."

✅ CORRECT (always do this):
User: "puxa as reuniões de sexta"
Agent: [calls bash: gws meet conferenceRecords list]
Agent: "Encontrei 25 reuniões. Aqui estão as de sexta-feira: ..."

❌ WRONG:
User: "lista minhas reuniões"
Agent: "Para acessar o Google Meet, preciso de autenticação OAuth..."

✅ CORRECT:
User: "lista minhas reuniões"
Agent: [calls bash: gws meet conferenceRecords list --params '{"pageSize":50}']
Agent: "Suas últimas reuniões: ..."

❌ WRONG:
User: "pega a transcrição da reunião Q&A"
Agent: "Não tenho integração com o Google Meet configurada..."

✅ CORRECT:
User: "pega a transcrição da reunião Q&A"
Agent: [calls bash: gws meet conferenceRecords list]
Agent: [finds Q&A meeting ID, calls bash: gws meet conferenceRecords transcripts list]
Agent: [calls bash: gws meet conferenceRecords transcripts entries list --page-all]
Agent: "Transcrição da reunião Q&A de sexta-feira: ..."
` : "";

  const systemPrompt = `You are Gates, an intelligent AI agent for your development workflow.

${capSection}${gwsGuide}
${fewShot}
## Rules
- ALWAYS call bash with gws/gh commands immediately — tools are authenticated, no setup needed
- NEVER say "não tenho acesso", "not configured", "OAuth required", "no credentials" — these are WRONG
- NEVER ask the user to run anything — you run it
- For meetings: list first, then filter/search, never ask before listing
- After tool calls: always write a final response summarizing results`;

  return {
    name: "Gates",
    description: "Your AI development agent",
    provider: { type: providerType as "anthropic" | "minimax" | "openai" },
    systemPrompt,
    tools: ["read", "write", "bash", "grep", "glob", "edit"],
  };
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

// ── Message type bridge ───────────────────────────────────────────────────────

const toProviderMessage = (m: Message): ProviderMessage => ({
  role: (m.role === "tool" ? "user" : m.role === "context" ? "system" : m.role) as ProviderMessage["role"],
  content: m.content,
  timestamp: m.timestamp,
});

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

// ── Session registry ─────────────────────────────────────────────────────────

const sessions = new Map<string, { harnessName: string; createdAt: number }>();
const defaultHarnessCache = new Map<string, HarnessConfig>(); // sessionId → default harness config
const sse = (type: string, data: unknown): string =>
  `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

// ── App ───────────────────────────────────────────────────────────────────────

export function createServer(harnesses: LoadedHarness[]) {
  const app = new Hono();

  // Default session — creates a session with the smart default harness
  app.post("/api/default-session", async (c) => {
    const defaultConfig = await buildDefaultHarness();
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { harnessName: "__default__", createdAt: Date.now() });
    // Store the default config so chat endpoint can use it
    defaultHarnessCache.set(sessionId, defaultConfig);
    return c.json({ sessionId, harnessName: defaultConfig.name });
  });

  // Model configuration
  app.get("/api/config/models", (c) =>
    c.json({ slots: readModelSlots(), knownModels: KNOWN_MODELS })
  );

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

        // Resolve harness config: use default cache for __default__ sessions
        const harnessConfig: HarnessConfig = meta.harnessName === "__default__"
          ? (defaultHarnessCache.get(sessionId) ?? await buildDefaultHarness())
          : harnesses.find((h) => h.name === meta.harnessName)?.config
            ?? await buildDefaultHarness();

        await write("start", { sessionId });
        await write("thinking", {});

        const provider = makeProvider(harnessConfig);

        // Load persisted history
        const store = await Effect.runPromise(makeFileSessionStore());
        const storageKey = `harness-ui:${sessionId}`;
        const existing = await Effect.runPromise(store.load(storageKey));
        const history = await Effect.runPromise(SessionHistory.fromData(existing));
        const contextMessages = await Effect.runPromise(history.buildContext());

        const activeRole = roleOverride ?? harnessConfig.defaultRole;
        const systemPrompt =
          harnessConfig.roles?.find((r) => r.name === activeRole)?.systemPrompt ??
          harnessConfig.systemPrompt ?? "You are a helpful assistant.";

        // Set up sandbox + tools + connectors
        const sandbox = await Effect.runPromise(makeLocalSandbox({ cwd: process.cwd() }));
        const allTools = toolsMap(sandbox);

        // Load connector tools (gws_meet, gws_calendar, gh, etc.)
        try {
          const { loadConnectors } = await import("@gatesai/skills");
          const connectorDir = `${process.cwd()}/.gates/connectors`;
          const savedK = readSavedKeys();
          const registry = await Effect.runPromise(
            loadConnectors(connectorDir, {
              GH_TOKEN: process.env.GH_TOKEN ?? savedK["github"] ?? "",
              GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:
                process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE ?? savedK["google-workspace"] ?? "",
            })
          );
          for (const [name, tool] of registry.allTools()) {
            allTools.set(name, tool);
          }
        } catch { /* connectors optional */ }

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

        const declaredToolNames = harnessConfig.tools ?? [];
        const isDefaultSession = meta.harnessName === "__default__";

        // Default sessions get ALL available tools (sandbox + connectors)
        // Named harnesses only get tools they declared
        const toolsToExpose = isDefaultSession
          ? [...allTools.keys()]
          : [...declaredToolNames, "fetch_url"];

        const providerTools: ProviderTool[] = toolsToExpose.flatMap((name) => {
          const t = allTools.get(name);
          return t ? [{ name: t.name, description: t.description, parameters: t.parameters }] : [];
        });

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

        // If model used tools but produced no final text, ask for a summary
        if (!finalContent.trim() && iteration > 0) {
          await write("thinking", {});
          const summaryResult = await Effect.runPromise(
            Effect.result(provider.chat(currentMessages))
          );
          if (summaryResult._tag === "Success") {
            finalContent = summaryResult.success.content;
          }
        }

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
