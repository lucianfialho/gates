import React from "react";
import { Box, Text } from "ink";

export interface ThinkingBlockData {
  id: string;
  text: string;
  durationMs: number;
  collapsed: boolean;
}

interface ActiveProps {
  text: string;
}

interface HistoryProps {
  block: ThinkingBlockData;
  onToggle: (id: string) => void;
}

// ── Streaming thinking (active, always expanded) ───────────────────────────

export function ActiveThinking({ text }: ActiveProps) {
  if (!text.trim()) return null;
  // Show last 3 lines to keep it compact while streaming
  const lines = text.split("\n").filter(Boolean);
  const visible = lines.slice(-3).join("\n");

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color="yellow">▼ </Text>
        <Text color="yellow" dimColor>pensando…</Text>
      </Box>
      <Box
        paddingLeft={2}
        borderStyle="single"
        borderLeft
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor="yellow"
      >
        <Text dimColor wrap="wrap">{visible}</Text>
      </Box>
    </Box>
  );
}

// ── Completed thinking block (collapsible) ────────────────────────────────

export function ThinkingBlock({ block, onToggle }: HistoryProps) {
  const { id, text, durationMs, collapsed } = block;
  const lines = text.split("\n").filter(Boolean);
  const preview = lines[0]?.slice(0, 55) ?? "";
  const seconds = (durationMs / 1000).toFixed(1);

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text
          color="yellow"
          dimColor
          // Ink doesn't support onClick, but we can navigate with useInput in parent
        >
          {collapsed ? "▶" : "▼"}{" "}
        </Text>
        <Text dimColor>
          pensou · {seconds}s
        </Text>
        {collapsed && preview && (
          <Text dimColor>  "{preview}{lines[0]!.length > 55 ? "…" : ""}"</Text>
        )}
      </Box>
      {!collapsed && (
        <Box
          paddingLeft={2}
          borderStyle="single"
          borderLeft
          borderRight={false}
          borderTop={false}
          borderBottom={false}
          borderColor="gray"
        >
          <Text dimColor wrap="wrap">{text.trim()}</Text>
        </Box>
      )}
    </Box>
  );
}
