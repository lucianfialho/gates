import React from "react";
import { Box, Text } from "ink";

interface Props {
  harnessName: string;
  sessionId: string;
  status: "idle" | "thinking" | "streaming" | "error";
  provider: string;
  width: number;
}

const STATUS_LABELS: Record<Props["status"], string> = {
  idle: "ready",
  thinking: "thinking…",
  streaming: "streaming…",
  error: "error",
};

const STATUS_COLORS: Record<Props["status"], string> = {
  idle: "green",
  thinking: "yellow",
  streaming: "cyan",
  error: "red",
};

export function StatusBar({ harnessName, sessionId, status, provider, width }: Props) {
  const left = ` ◆ ${harnessName}  ${provider}`;
  const right = `[${STATUS_LABELS[status]}]  session:${sessionId.slice(0, 8)} `;
  const mid = " ".repeat(Math.max(0, width - left.length - right.length));

  return (
    <Box>
      <Text backgroundColor="blue" color="white">
        {left}
        {mid}
        <Text color={STATUS_COLORS[status]}>{right}</Text>
      </Text>
    </Box>
  );
}
