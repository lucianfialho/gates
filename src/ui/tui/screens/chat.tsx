import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { MessageList, type ChatMessage, type ToolCallItem } from "../components/message-list.js";
import { SkillExecution, type SkillExecutionState } from "../components/skill-execution.js";
import { Spinner } from "../components/spinner.js";
import { StatusBar } from "../components/status-bar.js";
import { Sidebar, type SidebarData } from "../components/sidebar.js";
import { SkillsList, type SkillInfo } from "./skills-list.js";
import { KanbanBoard, type KanbanFinding } from "./kanban.js";
import type { LoadedHarness } from "../../harness/loader.js";
import { DEFAULT_PORT } from "../../server/index.js";

const SIDEBAR_WIDTH = 36;

// ── Slash commands registry ───────────────────────────────────────────────────

interface SlashCommand {
  name: string;
  description: string;
  usage: string;
  args?: Array<{ name: string; required: boolean; hint: string }>;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "code-review",
    description: "Revisa código e sugere melhorias",
    usage: "/code-review [path] [repo] [focus]  — detecta path e repo automaticamente",
    args: [
      { name: "path", required: false, hint: "./" },
      { name: "repo", required: false, hint: "detectado do git" },
      { name: "focus", required: false, hint: "security" },
    ],
  },
  {
    name: "sessions",
    description: "Ver sessões salvas",
    usage: "/sessions",
  },
  {
    name: "skills",
    description: "Listar skills disponíveis",
    usage: "/skills",
  },
  {
    name: "skill",
    description: "Executar uma skill pelo nome",
    usage: "/skill <nome> [key=value]",
    args: [{ name: "name", required: true, hint: "triage" }],
  },
  {
    name: "clear",
    description: "Limpar o chat",
    usage: "/clear",
  },
  {
    name: "role",
    description: "Mudar o role do agente",
    usage: "/role <nome>",
    args: [{ name: "name", required: true, hint: "planner" }],
  },
];

// ── Command menu component ────────────────────────────────────────────────────

function CommandMenu({
  commands,
  selectedIndex,
  width,
}: {
  commands: SlashCommand[];
  selectedIndex: number;
  width: number;
}) {
  if (commands.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginX={1}
      marginBottom={0}
    >
      {commands.map((cmd, i) => {
        const selected = i === selectedIndex;
        return (
          <Box key={cmd.name}>
            <Text bold color={selected ? "cyan" : "white"}>
              {selected ? "▶ " : "  "}
              <Text bold={selected}>{`/${cmd.name}`}</Text>
            </Text>
            <Text color="gray">{"  "}</Text>
            <Text dimColor={!selected}>{cmd.description}</Text>
            {selected && (
              <Text color="gray">{`  ${cmd.usage}`}</Text>
            )}
          </Box>
        );
      })}
      <Box marginTop={0}>
        <Text dimColor>↑↓ navega  Tab completa  Esc fecha</Text>
      </Box>
    </Box>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  harness: LoadedHarness;
  sessionId: string;
  onBack: () => void;
  onOpenSessions: () => void;
}

type Status = "idle" | "thinking" | "tool_calling" | "streaming" | "running_skill" | "error";

// ── SSE parser ────────────────────────────────────────────────────────────────

function parseSseChunk(buffer: string, chunk: string) {
  const updated = buffer + chunk;
  const lines = updated.split("\n");
  const remaining = lines.pop() ?? "";
  const events: Array<{ type: string; data: unknown }> = [];

  let currentEvent = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      try { events.push({ type: currentEvent, data: JSON.parse(line.slice(6)) }); } catch { /* skip */ }
      currentEvent = "";
    } else if (line === "") {
      currentEvent = "";
    }
  }
  return { buffer: remaining, events };
}

// ── Slash command helpers ─────────────────────────────────────────────────────

function getFilteredCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const query = input.slice(1).split(/\s/)[0] ?? "";
  // Only show menu when still on the command name (no space typed yet)
  if (input.includes(" ")) return [];
  return SLASH_COMMANDS.filter((c) =>
    c.name.toLowerCase().startsWith(query.toLowerCase())
  );
}

interface ParsedCommand {
  type: "code-review" | "skill" | "skills" | "sessions" | "clear" | "role" | "none";
  skillName?: string;
  skillArgs?: Record<string, unknown>;
  roleName?: string;
  reviewPath?: string;
  reviewRepo?: string;
  reviewFocus?: string;
}

function parseCommand(text: string): ParsedCommand {
  if (!text.startsWith("/")) return { type: "none" };
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd?.toLowerCase()) {
    case "skills":      return { type: "skills" };
    case "sessions":    return { type: "sessions" };
    case "clear":       return { type: "clear" };
    case "role":        return { type: "role", roleName: arg };
    case "code-review": {
      const [reviewPath, reviewRepo, ...focusParts] = rest;
      return {
        type: "code-review",
        reviewPath: reviewPath ?? ".",
        reviewRepo: reviewRepo ?? "",
        reviewFocus: focusParts.join(" ") || undefined,
      };
    }
    case "skill": {
      const [skillName, ...argParts] = arg.split(/\s+/);
      const skillArgs: Record<string, unknown> = {};
      for (const part of argParts) {
        const [k, ...v] = part.split("=");
        if (k) skillArgs[k] = v.join("=");
      }
      return { type: "skill", skillName, skillArgs };
    }
    default: return { type: "none" };
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function Chat({ harness, sessionId, onBack, onOpenSessions }: Props) {
  const { stdout } = useStdout();
  const width  = stdout?.columns ?? 80;
  const height = stdout?.rows ?? 24;

  const [messages, setMessages]             = useState<ChatMessage[]>([]);
  const [toolCalls, setToolCalls]           = useState<ToolCallItem[]>([]);
  const [skillExec, setSkillExec]           = useState<SkillExecutionState | null>(null);
  const [showSkillsList, setShowSkillsList] = useState(false);
  const [input, setInput]                   = useState("");
  const [status, setStatus]                 = useState<Status>("idle");
  const [streamingContent, setStreamingContent] = useState("");
  const [sidebarData, setSidebarData]       = useState<SidebarData | null>(null);
  const [showSidebar, setShowSidebar]       = useState(false);
  const [cmdMenuIndex, setCmdMenuIndex]     = useState(0);
  const [scrollOffset, setScrollOffset]     = useState(0);
  const [projectContext, setProjectContext] = useState<{ cwd: string; repo: string | null }>({ cwd: ".", repo: null });
  const [kanbanFindings, setKanbanFindings] = useState<KanbanFinding[] | null>(null);
  const [kanbanRepo, setKanbanRepo]         = useState("");
  const suppressNextAssistant               = useRef(false);
  const streamingMsgId = useRef<string | null>(null);
  const abortRef       = useRef<AbortController | null>(null);

  const filteredCommands = getFilteredCommands(input);
  const showCmdMenu      = filteredCommands.length > 0 && status === "idle";

  useEffect(() => { setShowSidebar(width >= 110); }, [width]);

  // Load project context (cwd + git repo) once on mount
  useEffect(() => {
    fetch(`http://localhost:${DEFAULT_PORT}/api/context`)
      .then((r) => r.json())
      .then((d: unknown) => setProjectContext(d as { cwd: string; repo: string | null }))
      .catch(() => {});
  }, []);

  // ── History load ─────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch(`http://localhost:${DEFAULT_PORT}/api/sessions/${sessionId}/history`)
      .then((r) => r.json())
      .then((data: unknown) => {
        const { messages: msgs } = data as { messages: Array<{ id: string; role: string; content: string; timestamp: number }> };
        setMessages(
          msgs
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ id: m.id, role: m.role as "user" | "assistant", content: m.content, timestamp: m.timestamp }))
        );
      })
      .catch((err) => {
        setMessages([{ id: crypto.randomUUID(), role: "system", content: `Failed to load history: ${String(err)}`, timestamp: Date.now() }]);
      });
  }, [sessionId]);

  // ── Reset menu index when filter changes ──────────────────────────────────────

  useEffect(() => { setCmdMenuIndex(0); }, [input]);
  useEffect(() => { setScrollOffset(0); }, [messages.length]);

  // ── Global key handler ───────────────────────────────────────────────────────

  useInput((char, key) => {
    if (showSkillsList) return;

    // ── Command menu navigation ──────────────────────────────────────────────
    if (showCmdMenu) {
      if (key.upArrow) {
        setCmdMenuIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (key.downArrow) {
        setCmdMenuIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (key.tab) {
        const selected = filteredCommands[cmdMenuIndex];
        if (selected) {
          // Complete to "/<name> " and place cursor after the space
          const completion = `/${selected.name} `;
          setInput(completion);
        }
        return;
      }
      if (key.escape) {
        setInput("");
        return;
      }
    }

    // ── Message scroll (↑↓ when menu closed, input empty) ───────────────────
    if (!showCmdMenu && !input) {
      if (key.upArrow)   { setScrollOffset((s) => s + 3); return; }
      if (key.downArrow) { setScrollOffset((s) => Math.max(0, s - 3)); return; }
      if (key.pageUp)    { setScrollOffset((s) => s + Math.floor((height - 6) / 2)); return; }
      if (key.pageDown)  { setScrollOffset((s) => Math.max(0, s - Math.floor((height - 6) / 2))); return; }
    }

    // ── Sidebar toggle ───────────────────────────────────────────────────────
    if (key.ctrl && char === "s") { setShowSidebar((v) => !v); return; }

    // ── Abort / back ─────────────────────────────────────────────────────────
    if (key.escape || (key.ctrl && char === "b")) {
      if (status !== "idle") {
        abortRef.current?.abort();
        setStatus("idle"); setStreamingContent(""); setToolCalls([]); setSkillExec(null);
        return;
      }
      onBack();
    }
  });

  // ── Run a skill ──────────────────────────────────────────────────────────────

  const runSkill = useCallback(async (skillName: string, skillInput: Record<string, unknown> = {}) => {
    setStatus("running_skill");
    setSkillExec({ name: skillName, states: [], done: false });
    setToolCalls([]);
    setStreamingContent("");

    const controller = new AbortController();
    abortRef.current = controller;

    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(), role: "system",
      content: `Running skill: ${skillName}`,
      timestamp: Date.now(),
    }]);

    try {
      const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/sessions/${sessionId}/skill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillName, input: skillInput }),
        signal: controller.signal,
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const { buffer, events } = parseSseChunk(sseBuffer, decoder.decode(value, { stream: true }));
        sseBuffer = buffer;

        for (const { type, data } of events) {
          const d = data as Record<string, unknown>;
          switch (type) {
            case "skill_start":
              setSkillExec({ name: d.name as string, states: (d.states as string[]).map((id) => ({ id, status: "waiting" })), done: false });
              break;
            case "skill_event": {
              const evType = d.type as string;
              const stateId = d.state as string | undefined;
              if (evType === "state_enter" && stateId) {
                setSkillExec((prev) => prev ? { ...prev, currentState: stateId, states: prev.states.map((s) => s.id === stateId ? { ...s, status: "running" } : s) } : null);
              } else if (evType === "state_exit" && stateId) {
                setSkillExec((prev) => prev ? { ...prev, states: prev.states.map((s) => s.id === stateId ? { ...s, status: "done" } : s) } : null);
              }
              break;
            }
            case "skill_complete":
              setSkillExec((prev) => prev ? { ...prev, done: true } : null);
              setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "system", content: `Skill completed`, timestamp: Date.now() }]);
              setStatus("idle");
              break;
            case "skill_error":
              setSkillExec((prev) => prev ? { ...prev, done: true, error: d.message as string } : null);
              setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "system", content: `Skill failed: ${d.message}`, timestamp: Date.now() }]);
              setStatus("idle");
              break;
            case "error":
              setStatus("error"); setTimeout(() => setStatus("idle"), 2000); break;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") { setStatus("error"); setTimeout(() => setStatus("idle"), 2000); }
      else setStatus("idle");
    }
  }, [sessionId]);

  // ── Send message ─────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || status !== "idle") return;

    // If command menu is open, Enter completes the selected command — never submits raw "/"
    if (showCmdMenu && filteredCommands.length > 0) {
      const selected = filteredCommands[cmdMenuIndex];
      if (selected) {
        setInput(`/${selected.name} `);
      }
      return;
    }

    // Don't send a bare "/" or incomplete command to the AI
    if (text.startsWith("/") && parseCommand(text).type === "none") {
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: "system",
        content: `Comando desconhecido: "${text}"\nDigite / para ver os comandos disponíveis.`,
        timestamp: Date.now(),
      }]);
      setInput("");
      return;
    }

    setInput("");
    setCmdMenuIndex(0);

    const cmd = parseCommand(text);

    if (cmd.type === "skills")   { setShowSkillsList(true); return; }
    if (cmd.type === "sessions") { onOpenSessions(); return; }
    if (cmd.type === "clear")    { setMessages([]); setSkillExec(null); setToolCalls([]); return; }

    if (cmd.type === "skill") {
      if (!cmd.skillName) {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "system", content: "Usage: /skill <name> [key=value ...]", timestamp: Date.now() }]);
        return;
      }
      await runSkill(cmd.skillName, cmd.skillArgs ?? {});
      return;
    }

    if (cmd.type === "code-review") {
      // Auto-fill from project context if not provided
      const reviewPath = cmd.reviewPath ?? ".";
      const reviewRepo = cmd.reviewRepo || projectContext.repo || "";

      if (!reviewRepo) {
        setMessages((prev) => [...prev, {
          id: crypto.randomUUID(), role: "system",
          content: [
            "Repo não detectado. Use:",
            "/code-review <repo>",
            "/code-review <path> <repo> [focus]",
            "",
            `Exemplo: /code-review ${projectContext.cwd.split("/").slice(-2).join("/")} owner/repo security`,
          ].join("\n"),
          timestamp: Date.now(),
        }]);
        return;
      }

      setInput("");
      return void runCodeReview(reviewPath, reviewRepo, cmd.reviewFocus);
    }

    await sendChatMessage(text);
  }, [input, status, sessionId, runSkill]);

  // ── Run code review via dedicated endpoint ───────────────────────────────────

  const runCodeReview = useCallback(async (path: string, repo: string, focus?: string) => {
    setStatus("thinking");
    setToolCalls([]);
    setKanbanFindings(null);
    setKanbanRepo(repo);
    suppressNextAssistant.current = false;

    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(), role: "user",
      content: `/code-review ${path} ${repo}${focus ? ` ${focus}` : ""}`,
      timestamp: Date.now(),
    }]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/code-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, repo, focus, maxIssues: 10, dryRun: false }),
        signal: controller.signal,
      });

      const reader  = res.body?.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const { buffer, events } = parseSseChunk(sseBuffer, decoder.decode(value, { stream: true }));
        sseBuffer = buffer;

        for (const { type, data } of events) {
          const d = data as Record<string, unknown>;
          switch (type) {
            case "start":    setStatus("thinking"); break;
            case "tool_call":
              setStatus("tool_calling");
              setToolCalls((prev) => [...prev, { id: d.id as string, name: d.name as string, args: d.args as string ?? d.args as string, status: "running" }]);
              break;
            case "tool_result":
              setToolCalls((prev) => prev.map((tc) => tc.id === (d.id as string)
                ? { ...tc, output: d.output as string, isError: !!d.isError, status: (d.isError ? "error" : "done") as ToolCallItem["status"] }
                : tc));
              break;
            case "kanban_update":
              setKanbanFindings(d.findings as KanbanFinding[]);
              setToolCalls([]);
              setStatus("idle");
              break;
            case "done":
              if (!kanbanFindings) setStatus("idle");
              break;
            case "error":
              setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "system", content: `Error: ${d.message}`, timestamp: Date.now() }]);
              setStatus("error");
              setTimeout(() => setStatus("idle"), 2000);
              break;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") { setStatus("error"); setTimeout(() => setStatus("idle"), 2000); }
      else { setStatus("idle"); setToolCalls([]); }
    }
  }, [sessionId, kanbanFindings]);

  const sendChatMessage = useCallback(async (text: string) => {
    if (!text || status !== "idle") return;

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setStatus("thinking");
    setToolCalls([]);
    setSkillExec(null);

    const assistantId = crypto.randomUUID();
    streamingMsgId.current = assistantId;
    setStreamingContent("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: controller.signal,
      });

      const reader  = res.body?.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const { buffer, events } = parseSseChunk(sseBuffer, decoder.decode(value, { stream: true }));
        sseBuffer = buffer;

        for (const { type, data } of events) {
          const d = data as Record<string, unknown>;
          switch (type) {
            case "thinking": setStatus("thinking"); break;
            case "tool_call":
              setStatus("tool_calling");
              setToolCalls((prev) => [...prev, { id: d.id as string, name: d.name as string, args: d.args as string, status: "running" }]);
              break;
            case "tool_result":
              setToolCalls((prev) => prev.map((tc) => tc.id === (d.id as string)
                ? { ...tc, output: d.output as string, isError: d.isError as boolean, status: (d.isError ? "error" : "done") as ToolCallItem["status"] }
                : tc));
              break;
            case "delta":
              setStatus("streaming");
              setStreamingContent((prev) => prev + ((d.text as string) ?? ""));
              break;
            case "sidebar_update":
              setSidebarData(d as unknown as SidebarData);
              if (!showSidebar) setShowSidebar(true);
              break;
            case "kanban_update": {
              const findings = d.findings as KanbanFinding[];
              setKanbanFindings(findings);
              setKanbanRepo(projectContext.repo ?? "");
              setStreamingContent("");
              setToolCalls([]);
              setStatus("idle");
              suppressNextAssistant.current = true;
              break;
            }
            case "done":
              if (suppressNextAssistant.current) {
                suppressNextAssistant.current = false;
              } else {
                setMessages((prev) => [...prev, { id: assistantId, role: "assistant" as const, content: d.content as string, timestamp: Date.now() }]);
              }
              setStreamingContent(""); setToolCalls([]); setStatus("idle");
              break;
            case "error":
              setMessages((prev) => [...prev, { id: assistantId, role: "system" as const, content: `Error: ${d.message}`, timestamp: Date.now() }]);
              setStreamingContent(""); setToolCalls([]); setStatus("error");
              setTimeout(() => setStatus("idle"), 2000);
              break;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") { setStatus("error"); setTimeout(() => setStatus("idle"), 2000); }
      else { setStatus("idle"); setToolCalls([]); }
    }
  }, [status, sessionId, showSidebar]);

  // ── Skills list overlay ───────────────────────────────────────────────────────

  if (showSkillsList) {
    return (
      <SkillsList
        onSelect={(skill: SkillInfo) => { setShowSkillsList(false); runSkill(skill.name, {}); }}
        onBack={() => setShowSkillsList(false)}
      />
    );
  }

  // ── Kanban overlay ────────────────────────────────────────────────────────────

  if (kanbanFindings !== null) {
    return (
      <KanbanBoard
        findings={kanbanFindings}
        repo={kanbanRepo}
        onClose={() => setKanbanFindings(null)}
        onCreateIssue={(finding) => {
          setKanbanFindings(null);
          void sendChatMessage(
            `cria issue no GitHub: ${finding.title}\n\n${finding.body}` +
            (finding.file ? `\n\nFile: ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "") +
            `\n\nSeverity: ${finding.severity}\nLabels: ${finding.labels.join(", ")}`
          );
        }}
        onCreateAll={(findings) => {
          setKanbanFindings(null);
          void sendChatMessage(
            `cria issues no GitHub para todos os findings do code review:\n\n` +
            findings.map((f, i) =>
              `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`
            ).join("\n")
          );
        }}
      />
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const displayMessages: ChatMessage[] = [
    ...messages,
    ...(streamingContent ? [{ id: streamingMsgId.current ?? "streaming", role: "assistant" as const, content: streamingContent, timestamp: Date.now(), streaming: true }] : []),
  ];

  const statusLabel: Record<Status, string> = {
    idle: "ready", thinking: "pensando…", tool_calling: "executando tools…",
    streaming: "respondendo…", running_skill: "executando skill…", error: "erro",
  };

  const statusColor: Record<Status, string> = {
    idle: "cyan", thinking: "yellow", tool_calling: "magenta",
    streaming: "green", running_skill: "blue", error: "red",
  };

  const mainWidth = showSidebar && sidebarData ? width - SIDEBAR_WIDTH : width;

  return (
    <Box flexDirection="column" height={height}>
      {/* Header */}
      <Box borderStyle="single" borderBottom paddingX={1}>
        <Text bold color="cyan">{harness.name}</Text>
        <Text dimColor>  / para comandos  Ctrl+S sidebar  Esc voltar</Text>
      </Box>

      {/* Body */}
      <Box flexGrow={1} flexDirection="row" overflow="hidden">
        {showSidebar && sidebarData && (
          <Sidebar data={sidebarData} width={SIDEBAR_WIDTH} height={height - 4} />
        )}

        <Box flexGrow={1} flexDirection="column" paddingX={1} paddingTop={1} overflow="hidden">
          {displayMessages.length === 0 && !skillExec && toolCalls.length === 0 ? (
            <Box flexGrow={1} alignItems="center" justifyContent="center">
              <Text dimColor>{harness.config.description ?? `Chat com ${harness.name}  —  digite / para ver comandos`}</Text>
            </Box>
          ) : (
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              {skillExec && <SkillExecution execution={skillExec} />}
              <MessageList messages={displayMessages} toolCalls={toolCalls} maxHeight={height - 6} width={mainWidth} scrollOffset={scrollOffset} />
            </Box>
          )}
        </Box>
      </Box>

      {/* Command menu — appears above input */}
      {showCmdMenu && (
        <CommandMenu
          commands={filteredCommands}
          selectedIndex={cmdMenuIndex}
          width={mainWidth}
        />
      )}

      {/* Input */}
      <Box borderStyle="single" borderTop paddingX={1}>
        <Text color="cyan">❯ </Text>
        <Box flexGrow={1}>
          {status === "idle" ? (
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={sendMessage}
              placeholder="Mensagem ou / para comandos…"
            />
          ) : (
            <Spinner label={statusLabel[status]} color={statusColor[status]} />
          )}
        </Box>
      </Box>

      <StatusBar
        harnessName={harness.name}
        sessionId={sessionId}
        status={status === "tool_calling" || status === "running_skill" ? "streaming" : status}
        provider={`${harness.config.provider.type}${harness.config.provider.model ? `/${harness.config.provider.model}` : ""}`}
        width={width}
      />
    </Box>
  );
}
