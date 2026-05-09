import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { LoadedHarness } from "../../harness/loader.js";

interface Props {
  harnesses: LoadedHarness[];
  onSelect: (harness: LoadedHarness) => void;
  onOpenSessions: () => void;
  onOpenConfig: () => void;
}

export function HarnessSelect({ harnesses, onSelect, onOpenSessions, onOpenConfig }: Props) {
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(harnesses.length - 1, s + 1));
    if (key.return) onSelect(harnesses[selected]!);
    if (input === "s") onOpenSessions();
    if (input === "c") onOpenConfig();
  });

  return (
    <Box flexDirection="column" padding={2}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ◆ Harness UI
        </Text>
        <Text dimColor>  Select a harness to start</Text>
      </Box>
      <Box flexDirection="column">
        {harnesses.map((h, i) => (
          <Box key={h.name} marginBottom={i === selected ? 0 : 0}>
            <Box width={2}>
              <Text color={i === selected ? "cyan" : undefined}>
                {i === selected ? "▶" : " "}
              </Text>
            </Box>
            <Box flexDirection="column">
              <Box>
                <Text bold={i === selected} color={i === selected ? "white" : "white"}>
                  {h.name}
                </Text>
                <Text dimColor>  {h.config.provider.type}</Text>
                {h.config.provider.model && (
                  <Text dimColor>/{h.config.provider.model}</Text>
                )}
              </Box>
              {h.config.description && (
                <Box paddingLeft={0}>
                  <Text dimColor>{h.config.description}</Text>
                </Box>
              )}
            </Box>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate  ↵ select  s sessions  c config  q quit</Text>
      </Box>
    </Box>
  );
}
