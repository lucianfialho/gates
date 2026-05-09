import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { DEFAULT_PORT } from "../../server/index.js";

interface ConfigItem {
  id: string;
  label: string;
  envVar: string;
  configured: boolean;
  source: "env" | "config" | "none";
  hint?: string;
}

interface ConfigStatus {
  providers: ConfigItem[];
  connectors: ConfigItem[];
}

interface Props {
  onDone: () => void;
  showSkipOption?: boolean;
}

type EditingState = { section: "providers" | "connectors"; id: string; label: string } | null;

export function ConfigScreen({ onDone, showSkipOption = false }: Props) {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<EditingState>(null);
  const [inputValue, setInputValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const load = useCallback(() => {
    fetch(`http://localhost:${DEFAULT_PORT}/api/auth/status`)
      .then((r) => r.json())
      .then((data: unknown) => setStatus(data as ConfigStatus))
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const allItems: Array<{ section: "providers" | "connectors"; item: ConfigItem }> = [
    ...(status?.providers ?? []).map((item) => ({ section: "providers" as const, item })),
    ...(status?.connectors ?? []).map((item) => ({ section: "connectors" as const, item })),
  ];

  const configuredCount = allItems.filter((x) => x.item.configured).length;

  useInput((input, key) => {
    if (editing) return;

    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(allItems.length - 1, s + 1));

    if (key.return && allItems[selected]) {
      const { section, item } = allItems[selected]!;
      if (item.source === "env") {
        setSavedMsg(`${item.label} is set via environment variable ${item.envVar} — edit there to change it.`);
        setTimeout(() => setSavedMsg(""), 3000);
        return;
      }
      setEditing({ section, id: item.id, label: item.label });
      setInputValue("");
    }

    if (key.escape || input === "q") onDone();
  });

  const handleSave = async () => {
    if (!editing || !inputValue.trim()) {
      setEditing(null);
      return;
    }
    setSaving(true);
    try {
      await fetch(`http://localhost:${DEFAULT_PORT}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: editing.section, id: editing.id, value: inputValue.trim() }),
      });
      setSavedMsg(`✓ ${editing.label} saved`);
      setTimeout(() => setSavedMsg(""), 2000);
      load();
    } finally {
      setSaving(false);
      setEditing(null);
    }
  };

  if (!status) {
    return <Box padding={2}><Text dimColor>Loading…</Text></Box>;
  }

  // Editing a field
  if (editing) {
    return (
      <Box flexDirection="column" padding={2}>
        <Box marginBottom={1}>
          <Text bold color="cyan">◆ Configure {editing.label}</Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>
            {editing.section === "providers"
              ? `Paste your API key (will be saved to ~/.gates/config.json):`
              : `Enter the value:`}
          </Text>
        </Box>
        <Box>
          <Text color="cyan">❯ </Text>
          <TextInput
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSave}
            placeholder={editing.section === "providers" ? "sk-..." : ""}
            mask={editing.section === "providers" ? "*" : undefined}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↵ save  Esc cancel</Text>
        </Box>
      </Box>
    );
  }

  const hasAnything = configuredCount > 0;

  return (
    <Box flexDirection="column" padding={2}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">◆ gates — Configuration</Text>
        <Text dimColor>  {configuredCount}/{allItems.length} configured</Text>
      </Box>

      {/* Providers section */}
      <Box marginBottom={1}>
        <Text bold dimColor>AI Providers</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
        {allItems
          .filter((x) => x.section === "providers")
          .map(({ item }, i) => {
            const globalIdx = i;
            const isSelected = selected === globalIdx;
            return (
              <Box key={item.id}>
                <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "▶ " : "  "}</Text>
                <Text bold={isSelected} color={item.configured ? "green" : "white"}>
                  {item.configured ? "✓" : "✗"}
                </Text>
                <Text> {item.label.padEnd(16)}</Text>
                {item.configured ? (
                  <Text dimColor>{item.source === "env" ? `$${item.envVar}` : "~/.gates/config.json"}</Text>
                ) : (
                  <Text color="yellow">not configured — press ↵ to add</Text>
                )}
              </Box>
            );
          })}
      </Box>

      {/* Connectors section */}
      <Box marginBottom={1}>
        <Text bold dimColor>Connectors</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
        {allItems
          .filter((x) => x.section === "connectors")
          .map(({ item }, i) => {
            const globalIdx = status.providers.length + i;
            const isSelected = selected === globalIdx;
            return (
              <Box key={item.id} flexDirection="column">
                <Box>
                  <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "▶ " : "  "}</Text>
                  <Text bold={isSelected} color={item.configured ? "green" : "white"}>
                    {item.configured ? "✓" : "✗"}
                  </Text>
                  <Text> {item.label.padEnd(20)}</Text>
                  {item.configured ? (
                    <Text dimColor>{item.source === "env" ? `$${item.envVar}` : "saved"}</Text>
                  ) : (
                    <Text dimColor>{item.hint ?? "not configured"}</Text>
                  )}
                </Box>
              </Box>
            );
          })}
      </Box>

      {/* Feedback message */}
      {savedMsg && (
        <Box marginBottom={1}>
          <Text color="green">{savedMsg}</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>↑↓ navigate  ↵ configure  {showSkipOption && hasAnything ? "s skip  " : ""}Esc back</Text>
        {!hasAnything && (
          <Box marginTop={1}>
            <Text color="yellow">⚠ Configure at least one AI provider to start.</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
