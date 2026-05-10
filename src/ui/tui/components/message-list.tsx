import React from "react";
import { Box, Text } from "ink";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  streaming?: boolean;
}

export interface ToolCallItem {
  id: string;
  name: string;
  args: string;
  output?: string;
  isError?: boolean;
  status: "running" | "done" | "error";
}

interface Props {
  messages: ChatMessage[];
  toolCalls: ToolCallItem[];
  maxHeight: number;
  width?: number;
  /** Lines scrolled up from the bottom. 0 = newest visible (default). */
  scrollOffset?: number;
}

// ── Line estimation ────────────────────────────────────────────────────────────

function estimateMessageLines(msg: ChatMessage, contentWidth: number): number {
  let lines = 1; // header row
  for (const line of msg.content.split("\n")) {
    lines += Math.max(1, Math.ceil((line.length || 1) / contentWidth));
  }
  return lines + 1; // marginBottom
}

// ── ToolCall ───────────────────────────────────────────────────────────────────

function ToolCall({ call }: { call: ToolCallItem }) {
  const icon  = call.status === "running" ? "⟳" : call.isError ? "✗" : "✓";
  const color = call.status === "running" ? "yellow" : call.isError ? "red" : "green";

  let argsPreview = "";
  try {
    const parsed = JSON.parse(call.args);
    const first = Object.entries(parsed)[0];
    if (first) argsPreview = `${first[0]}=${String(first[1]).slice(0, 40)}`;
  } catch {
    argsPreview = call.args.slice(0, 50);
  }

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color={color}>{icon} </Text>
        <Text color="magenta" bold>{call.name}</Text>
        {argsPreview && <Text dimColor>({argsPreview})</Text>}
      </Box>
      {call.output && call.status !== "running" && (
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate-end">
            {call.output.split("\n").slice(0, 3).join(" ↵ ").slice(0, 120)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ── MessageList ────────────────────────────────────────────────────────────────

export function MessageList({ messages, toolCalls, maxHeight, width = 80, scrollOffset = 0 }: Props) {
  const contentWidth    = Math.max(20, width - 8);
  const toolLines       = toolCalls.length > 0 ? toolCalls.length * 2 + 2 : 0;
  const scrollIndicator = 1;
  const available       = Math.max(4, maxHeight - toolLines - scrollIndicator);
  const isScrolled      = scrollOffset > 0;

  // ── Build visible window ───────────────────────────────────────────────────
  // Walk backwards through messages, skipping `scrollOffset` lines from bottom,
  // then filling `available` lines going further back.

  let toSkip    = scrollOffset;  // lines still to skip
  let linesUsed = 0;
  const visibleMessages: ChatMessage[] = [];
  const skippedAtBottom: ChatMessage[] = []; // messages hidden below scroll

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const est = estimateMessageLines(msg, contentWidth);

    if (toSkip > 0) {
      // Still in the skipped zone at the bottom
      toSkip -= est;
      skippedAtBottom.push(msg);
      continue;
    }

    if (linesUsed + est > available && visibleMessages.length > 0) break;
    linesUsed += est;
    visibleMessages.unshift(msg);
  }

  const hiddenAbove = messages.length - visibleMessages.length - skippedAtBottom.length;
  const hiddenBelow = skippedAtBottom.length;

  // ── Content renderer ───────────────────────────────────────────────────────
  // When scrolled: show full message content (no cap — user is reading deliberately)
  // When at bottom: cap very long messages to keep newest visible
  const renderContent = (msg: ChatMessage): string => {
    if (isScrolled || msg.streaming) return msg.content;

    const lines = msg.content.split("\n");
    const cap   = Math.max(8, Math.floor(available * 0.75));
    if (lines.length <= cap) return msg.content;
    return "…\n" + lines.slice(-cap).join("\n");
  };

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">

      {/* ── Top indicator ── */}
      <Box paddingLeft={2}>
        {hiddenAbove > 0
          ? <Text dimColor>↑ {hiddenAbove} mensagem{hiddenAbove > 1 ? "s" : ""} acima  (↑ para subir)</Text>
          : <Text dimColor> </Text>
        }
      </Box>

      {/* ── Messages ── */}
      {visibleMessages.map((msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={1}>
          <Box>
            <Text bold color={msg.role === "user" ? "cyan" : msg.role === "assistant" ? "green" : "yellow"}>
              {msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : "System"}
            </Text>
            <Text dimColor>
              {" "}{new Date(msg.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </Text>
            {msg.streaming && <Text color="yellow"> ●</Text>}
          </Box>
          <Box paddingLeft={2}>
            <Text wrap="wrap">{renderContent(msg)}</Text>
          </Box>
        </Box>
      ))}

      {/* ── Tool calls (only when at bottom) ── */}
      {!isScrolled && toolCalls.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
          {toolCalls.map((tc) => <ToolCall key={tc.id} call={tc} />)}
        </Box>
      )}

      {/* ── Bottom indicator ── */}
      {hiddenBelow > 0 && (
        <Box paddingLeft={2}>
          <Text color="cyan">↓ {hiddenBelow} mensagem{hiddenBelow > 1 ? "s" : ""} abaixo  (↓ para descer)</Text>
        </Box>
      )}
    </Box>
  );
}
