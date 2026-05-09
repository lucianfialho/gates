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
}

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

export function MessageList({ messages, toolCalls, maxHeight }: Props) {
  const visible = messages.slice(-Math.floor(maxHeight / 3));

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visible.map((msg) => (
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
            <Text wrap="wrap">{msg.content}</Text>
          </Box>
        </Box>
      ))}

      {/* Active tool calls displayed after last message, cleared on done */}
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
