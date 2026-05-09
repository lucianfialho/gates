import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { LoadedHarness } from "../../harness/loader.js";
import { DEFAULT_PORT } from "../../server/index.js";

interface Props {
  harnesses: LoadedHarness[];
  onSelect: (harness: LoadedHarness) => void;
  onOpenSessions: () => void;
  onOpenConfig: () => void;
}

export function HarnessSelect({ harnesses, onSelect, onOpenSessions, onOpenConfig }: Props) {
  const [selected, setSelected] = useState(0);
  const [configuredProviders, setConfiguredProviders] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch(`http://localhost:${DEFAULT_PORT}/api/auth/status`)
      .then((r) => r.json())
      .then((data: unknown) => {
        const d = data as { providers: Array<{ id: string; configured: boolean }> };
        setConfiguredProviders(
          new Set(d.providers.filter((p) => p.configured).map((p) => p.id))
        );
      })
      .catch(() => {});
  }, []);

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
        <Text bold color="cyan">◆ gates</Text>
        <Text dimColor>  Select a harness</Text>
      </Box>

      <Box flexDirection="column">
        {harnesses.map((h, i) => {
          const isSelected = i === selected;
          const providerType = h.config.provider.type ?? "minimax";
          const isReady = configuredProviders.has(providerType);

          return (
            <Box key={h.name} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={isSelected ? "cyan" : undefined}>
                  {isSelected ? "▶ " : "  "}
                </Text>
                <Text bold={isSelected}>{h.name}</Text>
                <Text dimColor>  {providerType}</Text>
                {h.config.provider.model && (
                  <Text dimColor>/{h.config.provider.model}</Text>
                )}
                {/* Provider status indicator */}
                <Text color={isReady ? "green" : "yellow"}>
                  {" "}{isReady ? "✓" : "⚠ not configured — press c"}
                </Text>
              </Box>
              {h.config.description && (
                <Box paddingLeft={4}>
                  <Text dimColor>{h.config.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate  ↵ select  s sessions  c config  q quit</Text>
      </Box>
    </Box>
  );
}
