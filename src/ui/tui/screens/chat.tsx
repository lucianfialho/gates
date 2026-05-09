import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { MessageList, type ChatMessage, type ToolCallItem } from "../components/message-list.js";
import { SkillExecution, type SkillExecutionState } from "../components/skill-execution.js";
import { StatusBar } from "../components/status-bar.js";
import { Sidebar, type SidebarData } from "../components/sidebar.js";
import { SkillsList, type SkillInfo } from "./skills-list.js";
import type { LoadedHarness } from "../../harness/loader.js";
import { DEFAULT_PORT } from "../../server/index.js";

const SIDEBAR_WIDTH = 36;

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

// ── Command parser ────────────────────────────────────────────────────────────

interface ParsedCommand {
  type: "skill" | "skills" | "sessions" | "clear" | "role" | "none";
  skillName?: string;
  skillArgs?: Record<string, unknown>;
  roleName?: string;
}

function parseCommand(text: string): ParsedCommand {
  if (!text.startsWith("/")) return { type: "none" };
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd?.toLowerCase()) {
    case "skills": return { type: "skills" };
    case "sessions": return { type: "sessions" };
    case "clear": return { type: "clear" };
    case "role": return { type: "role", roleName: arg };
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
  const width = stdout?.columns ?? 80;
  const height = stdout?.rows ?? 24;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallItem[]>([]);
  const [skillExec, setSkillExec] = useState<SkillExecutionState | null>(null);
  const [showSkillsList, setShowSkillsList] = useState(false);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [streamingContent, setStreamingContent] = useState("");
  const [sidebarData, setSidebarData] = useState<SidebarData | null>(null);
  const [showSidebar, setShowSidebar] = useState(false);
  const streamingMsgId = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Show sidebar automatically when terminal is wide enough
  useEffect(() => {
    setShowSidebar(width >= 110);
  }, [width]);

  // Load history
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
      .catch(() => {});
  }, [sessionId]);

  useInput((inputChar, key) => {
    if (showSkillsList) return;
    if (key.ctrl && inputChar === "s") { setShowSidebar((v) => !v); return; }
    if (key.escape || (key.ctrl && inputChar === "b")) {
      if (status !== "idle") { abortRef.current?.abort(); setStatus("idle"); setStreamingContent(""); setToolCalls([]); setSkillExec(null); return; }
      onBack();
    }
  });

  // ── Run a skill ─────────────────────────────────────────────────────────────

  const runSkill = useCallback(async (skillName: string, skillInput: Record<string, unknown> = {}) => {
    setStatus("running_skill");
    setSkillExec({ name: skillName, states: [], done: false });
    setToolCalls([]);
    setStreamingContent("");

    const controller = new AbortController();
    abortRef.current = controller;

    // System message in chat
    setMessages((prev) => [...prev, {
      id: crypto.randomUUID(), role: "system",
      content: `Running skill: ${skillName}${Object.keys(skillInput).length > 0 ? ` (${JSON.stringify(skillInput)})` : ""}`,
      timestamp: Date.now(),
    }]);

    try {
      const res = await fetch(
        `http://localhost:${DEFAULT_PORT}/api/sessions/${sessionId}/skill`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skillName, input: skillInput }),
          signal: controller.signal,
        }
      );

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
              setSkillExec({
                name: d.name as string,
                states: (d.states as string[]).map((id) => ({ id, status: "waiting" })),
                currentState: undefined,
                done: false,
              });
              break;

            case "skill_event": {
              const evType = d.type as string;
              const stateId = d.state as string | undefined;

              if (evType === "state_enter" && stateId) {
                setSkillExec((prev) => prev ? {
                  ...prev,
                  currentState: stateId,
                  states: prev.states.map((s) =>
                    s.id === stateId ? { ...s, status: "running" } : s
                  ),
                } : null);
              } else if (evType === "state_exit" && stateId) {
                setSkillExec((prev) => prev ? {
                  ...prev,
                  states: prev.states.map((s) =>
                    s.id === stateId ? { ...s, status: "done" } : s
                  ),
                } : null);
              } else if (evType === "tool_call" && stateId) {
                const toolName = (d.data as Record<string, unknown>)?.tool as string;
                setSkillExec((prev) => prev ? {
                  ...prev,
                  states: prev.states.map((s) =>
                    s.id === stateId ? { ...s, tool: toolName } : s
                  ),
                } : null);
              } else if (evType === "tool_result" && stateId) {
                const result = String((d.data as Record<string, unknown>)?.result ?? "").slice(0, 100);
                setSkillExec((prev) => prev ? {
                  ...prev,
                  states: prev.states.map((s) =>
                    s.id === stateId ? { ...s, output: result } : s
                  ),
                } : null);
              } else if (evType === "skill_error") {
                const errMsg = String((d.data as Record<string, unknown>)?.error ?? "");
                setSkillExec((prev) => prev ? {
                  ...prev,
                  states: prev.states.map((s) =>
                    s.id === prev.currentState ? { ...s, status: "error" } : s
                  ),
                  error: errMsg,
                } : null);
              }
              break;
            }

            case "sidebar_update":
              setSidebarData(d as unknown as SidebarData);
              if (!showSidebar) setShowSidebar(true);
              break;

            case "skill_complete": {
              const result = d as { name: string; state: string; results: unknown[]; errors: unknown[]; lastOutput: unknown };
              setSkillExec((prev) => prev ? { ...prev, done: true, states: prev.states.map((s) => ({ ...s, status: s.status === "running" ? "done" as const : s.status })) } : null);

              // Auto-populate sidebar from action item extraction
              if (result.name === "extract-action-items" && result.lastOutput) {
                try {
                  const items = JSON.parse(String(result.lastOutput)) as Array<{ title: string; assignee?: string; priority?: string }>;
                  setSidebarData({
                    title: "Action Items",
                    sections: [{
                      title: `Extracted (${items.length})`,
                      items: items.map((item) => ({
                        label: item.title,
                        status: "pending" as const,
                        value: item.assignee ?? item.priority,
                      })),
                    }],
                  });
                  if (!showSidebar) setShowSidebar(true);
                } catch { /* not JSON, skip */ }
              }

              const summary = result.errors.length > 0
                ? `Skill completed with ${result.errors.length} error(s) in state "${result.state}"`
                : `Skill completed — ${result.results.length} step(s), final state: "${result.state}"`;
              setMessages((prev) => [...prev, {
                id: crypto.randomUUID(), role: "system",
                content: summary, timestamp: Date.now(),
              }]);
              setStatus("idle");
              break;
            }

            case "skill_error":
              setSkillExec((prev) => prev ? { ...prev, done: true, error: d.message as string } : null);
              setMessages((prev) => [...prev, {
                id: crypto.randomUUID(), role: "system",
                content: `Skill failed: ${d.message}`, timestamp: Date.now(),
              }]);
              setStatus("idle");
              break;

            case "error":
              setStatus("error");
              setTimeout(() => setStatus("idle"), 2000);
              break;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStatus("error");
        setTimeout(() => setStatus("idle"), 2000);
      } else {
        setStatus("idle");
      }
    }
  }, [sessionId]);

  // ── Send chat message ────────────────────────────────────────────────────────

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || status !== "idle") return;
    setInput("");

    const cmd = parseCommand(text);

    if (cmd.type === "skills") { setShowSkillsList(true); return; }
    if (cmd.type === "sessions") { onOpenSessions(); return; }

    if (cmd.type === "skill") {
      if (!cmd.skillName) {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "system", content: "Usage: /skill <name> [key=value ...]", timestamp: Date.now() }]);
        return;
      }
      await runSkill(cmd.skillName, cmd.skillArgs ?? {});
      return;
    }

    if (cmd.type === "clear") {
      setMessages([]);
      setSkillExec(null);
      setToolCalls([]);
      return;
    }

    // Regular chat message
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
      const res = await fetch(
        `http://localhost:${DEFAULT_PORT}/api/sessions/${sessionId}/chat`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text }), signal: controller.signal }
      );

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
            case "thinking": setStatus("thinking"); break;
            case "tool_call":
              setStatus("tool_calling");
              setToolCalls((prev) => [...prev, { id: d.id as string, name: d.name as string, args: d.args as string, status: "running" }]);
              break;
            case "tool_result":
              setToolCalls((prev) => prev.map((tc) => tc.id === (d.id as string)
                ? { ...tc, output: d.output as string, isError: d.isError as boolean, status: (d.isError ? "error" : "done") as ToolCallItem["status"] }
                : tc
              ));
              break;
            case "delta":
              setStatus("streaming");
              setStreamingContent((prev) => prev + ((d.text as string) ?? ""));
              break;
            case "sidebar_update":
              setSidebarData(d as unknown as SidebarData);
              if (!showSidebar) setShowSidebar(true);
              break;
            case "done":
              setMessages((prev) => [...prev, { id: assistantId, role: "assistant" as const, content: d.content as string, timestamp: Date.now() }]);
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
  }, [input, status, sessionId, runSkill]);

  // ── Skills list overlay ──────────────────────────────────────────────────────

  if (showSkillsList) {
    return (
      <SkillsList
        onSelect={(skill: SkillInfo) => {
          setShowSkillsList(false);
          runSkill(skill.name, {});
        }}
        onBack={() => setShowSkillsList(false)}
      />
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const displayMessages: ChatMessage[] = [
    ...messages,
    ...(streamingContent ? [{ id: streamingMsgId.current ?? "streaming", role: "assistant" as const, content: streamingContent, timestamp: Date.now(), streaming: true }] : []),
  ];

  const statusLabel: Record<Status, string> = {
    idle: "ready", thinking: "thinking…", tool_calling: "calling tools…",
    streaming: "streaming…", running_skill: "running skill…", error: "error",
  };

  const mainWidth = showSidebar && sidebarData ? width - SIDEBAR_WIDTH : width;

  return (
    <Box flexDirection="column" height={height}>
      {/* Header */}
      <Box borderStyle="single" borderBottom paddingX={1}>
        <Text bold color="cyan">{harness.name}</Text>
        <Text dimColor>  /sessions  /skills  /skill  Ctrl+S sidebar  Esc back</Text>
      </Box>

      {/* Body: sidebar + main */}
      <Box flexGrow={1} flexDirection="row" overflow="hidden">
        {showSidebar && sidebarData && (
          <Sidebar
            data={sidebarData}
            width={SIDEBAR_WIDTH}
            height={height - 4}
          />
        )}

        <Box flexGrow={1} flexDirection="column" paddingX={1} paddingTop={1} overflow="hidden">
          {displayMessages.length === 0 && !skillExec && toolCalls.length === 0 ? (
            <Box flexGrow={1} alignItems="center" justifyContent="center">
              <Text dimColor>{harness.config.description ?? `Chat with ${harness.name}`}</Text>
            </Box>
          ) : (
            <Box flexDirection="column" flexGrow={1} overflow="hidden">
              {skillExec && <SkillExecution execution={skillExec} />}
              <MessageList messages={displayMessages} toolCalls={toolCalls} maxHeight={height - 6} />
            </Box>
          )}
        </Box>
      </Box>

      {/* Input */}
      <Box borderStyle="single" borderTop paddingX={1}>
        <Text color="cyan">❯ </Text>
        <Box flexGrow={1}>
          {status === "idle" ? (
            <TextInput value={input} onChange={setInput} onSubmit={sendMessage} placeholder="Message or /skill <name>…" />
          ) : (
            <Text dimColor>{statusLabel[status]}</Text>
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
