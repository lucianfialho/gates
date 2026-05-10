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
}

// ── Line estimation ────────────────────────────────────────────────────────────

function estimateMessageLines(msg: ChatMessage, contentWidth: number): number {
  let lines = 1; // header row (role + time)
  for (const line of msg.content.split("\n")) {
    lines += Math.max(1, Math.ceil((line.length || 1) / contentWidth));
  }
  return lines + 1; // +1 for marginBottom
}

// ── ToolCall ───────────────────────────────────────────────────────────────────

function ToolCall({ call }: { call: ToolCallItem }) {
  const icon = call.status === "running" ? "⟳" : call.isError ? "✗" : "✓";
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

export function MessageList({ messages, toolCalls, maxHeight, width = 80 }: Props) {
  const contentWidth = Math.max(20, width - 8);

  // Lines consumed by tool calls panel
  const toolLines = toolCalls.length > 0 ? toolCalls.length * 2 + 1 : 0;
  const availableForMessages = Math.max(4, maxHeight - toolLines);

  // Fill visible messages from the END — newest messages always visible
  let linesUsed = 0;
  const visibleMessages: ChatMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const est = estimateMessageLines(messages[i], contentWidth);
    if (linesUsed + est > availableForMessages && visibleMessages.length > 0) break;
    linesUsed += est;
    visibleMessages.unshift(messages[i]);
  }

  const hiddenCount = messages.length - visibleMessages.length;

  // For each message, cap content height so a single giant response
  // doesn't push everything else off screen
  const renderContent = (msg: ChatMessage): string => {
    const lines = msg.content.split("\n");
    // Max lines we'll display for a single message
    const cap = Math.max(8, Math.floor(availableForMessages * 0.75));
    if (lines.length <= cap) return msg.content;

    if (msg.streaming) {
      // During streaming show the LAST lines (tail follows new output)
      return "…\n" + lines.slice(-cap).join("\n");
    }
    // Completed messages: show tail so user sees the end
    return "…\n" + lines.slice(-cap).join("\n");
  };

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* Scroll indicator */}
      {hiddenCount > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>↑ {hiddenCount} earlier message{hiddenCount > 1 ? "s" : ""} (scroll up in terminal)</Text>
        </Box>
      )}

      {visibleMessages.map((msg) => (
        <Box key={msg.id} flexDirection="column" marginBottom={1}>
          <Box>
            <Text
              bold
              color={
                msg.role === "user" ? "cyan"
                : msg.role === "assistant" ? "green"
                : "yellow"
              }
            >
              {msg.role === "user" ? "You" : msg.role === "assistant" ? "Agent" : "System"}
            </Text>
            <Text dimColor>
              {" "}
              {new Date(msg.timestamp).toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
            {msg.streaming && <Text color="yellow"> ●</Text>}
          </Box>
          <Box paddingLeft={2}>
            <Text wrap="wrap">{renderContent(msg)}</Text>
          </Box>
        </Box>
      ))}

      {/* Active tool calls — always at the bottom */}
      {toolCalls.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
          {toolCalls.map((tc) => (
            <ToolCall key={tc.id} call={tc} />
          ))}
        </Box>
      )}
    </Box>
  );
}
