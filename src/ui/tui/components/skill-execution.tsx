import React from "react";
import { Box, Text } from "ink";

export interface SkillStateStatus {
  id: string;
  status: "waiting" | "running" | "done" | "error";
  tool?: string;
  output?: string;
}

export interface SkillExecutionState {
  name: string;
  states: SkillStateStatus[];
  currentState?: string;
  done: boolean;
  error?: string;
}

interface Props {
  execution: SkillExecutionState;
}

const STATE_ICON: Record<SkillStateStatus["status"], string> = {
  waiting: "○",
  running: "⟳",
  done: "✓",
  error: "✗",
};

const STATE_COLOR: Record<SkillStateStatus["status"], string> = {
  waiting: "gray",
  running: "yellow",
  done: "green",
  error: "red",
};

export function SkillExecution({ execution }: Props) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={0}>
        <Text color="magenta" bold>◆ skill: </Text>
        <Text bold>{execution.name}</Text>
        {execution.done && !execution.error && <Text color="green"> ✓ done</Text>}
        {execution.error && <Text color="red"> ✗ {execution.error}</Text>}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {execution.states.map((st) => (
          <Box key={st.id} flexDirection="column">
            <Box>
              <Text color={STATE_COLOR[st.status]}>{STATE_ICON[st.status]} </Text>
              <Text color={st.status === "running" ? "white" : "white"} dimColor={st.status === "waiting"}>
                {st.id}
              </Text>
              {st.tool && st.status === "running" && (
                <Text dimColor>  → {st.tool}</Text>
              )}
            </Box>
            {st.output && st.status === "done" && (
              <Box paddingLeft={2}>
                <Text dimColor wrap="truncate-end">
                  {st.output.split("\n").slice(0, 2).join(" ↵ ").slice(0, 100)}
                </Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
