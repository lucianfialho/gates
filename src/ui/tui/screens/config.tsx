import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { DEFAULT_PORT } from "../../server/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProviderItem {
  id: string;
  label: string;
  envVar: string;
  configured: boolean;
  source: "env" | "config" | "none";
}

interface ConnectorItem {
  id: string;
  label: string;
  description: string;
  installed: boolean;
  authenticated: boolean;
  user: string | null;
  version: string | null;
  installCmd: string;
  authCmd: string;
}

interface AuthStatus { providers: ProviderItem[] }
interface ConnectorStatus { connectors: ConnectorItem[] }

// ── Helpers ───────────────────────────────────────────────────────────────────

type TabId = "providers" | "connectors";

interface Props {
  onDone: () => void;
  showSkipOption?: boolean;
}

type EditingState = { type: "provider"; id: string; label: string } | null;

// ── Component ─────────────────────────────────────────────────────────────────

export function ConfigScreen({ onDone, showSkipOption = false }: Props) {
  const [tab, setTab] = useState<TabId>("providers");
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [connectors, setConnectors] = useState<ConnectorItem[]>([]);
  const [loadingConnectors, setLoadingConnectors] = useState(true);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<EditingState>(null);
  const [inputValue, setInputValue] = useState("");
  const [message, setMessage] = useState("");

  const flash = (msg: string) => { setMessage(msg); setTimeout(() => setMessage(""), 3000); };

  const loadProviders = useCallback(() => {
    fetch(`http://localhost:${DEFAULT_PORT}/api/auth/status`)
      .then((r) => r.json())
      .then((d: unknown) => setProviders((d as AuthStatus).providers))
      .catch(() => {});
  }, []);

  const loadConnectors = useCallback(() => {
    setLoadingConnectors(true);
    fetch(`http://localhost:${DEFAULT_PORT}/api/connectors/status`)
      .then((r) => r.json())
      .then((d: unknown) => { setConnectors((d as ConnectorStatus).connectors); setLoadingConnectors(false); })
      .catch(() => setLoadingConnectors(false));
  }, []);

  useEffect(() => { loadProviders(); loadConnectors(); }, [loadProviders, loadConnectors]);

  const currentList = tab === "providers" ? providers : connectors;

  useInput((input, key) => {
    if (editing) return;

    if (key.tab || input === "\t") {
      setTab((t) => t === "providers" ? "connectors" : "providers");
      setSelected(0);
      return;
    }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(currentList.length - 1, s + 1));
    if (key.escape || input === "q") onDone();

    if (key.return) {
      if (tab === "providers") {
        const item = providers[selected];
        if (!item) return;
        if (item.source === "env") {
          flash(`${item.label} is set via $${item.envVar} — edit your shell environment to change it.`);
          return;
        }
        setEditing({ type: "provider", id: item.id, label: item.label });
        setInputValue("");
      }
      // connectors: Enter just shows the commands (they run externally)
      if (tab === "connectors") {
        const item = connectors[selected];
        if (!item) return;
        if (!item.installed) {
          flash(`Run in another terminal: ${item.installCmd}`);
        } else if (!item.authenticated) {
          flash(`Run in another terminal: ${item.authCmd}`);
        } else {
          flash(`${item.label} is ready ✓`);
        }
      }
    }

    if (input === "r" && tab === "connectors") {
      loadConnectors();
      flash("Refreshing connector status…");
    }
  });

  const handleSave = async () => {
    if (!editing || !inputValue.trim()) { setEditing(null); return; }
    try {
      await fetch(`http://localhost:${DEFAULT_PORT}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section: "providers", id: editing.id, value: inputValue.trim() }),
      });
      flash(`✓ ${editing.label} saved`);
      loadProviders();
    } finally {
      setEditing(null);
    }
  };

  // ── Editing a provider key ───────────────────────────────────────────────────

  if (editing) {
    return (
      <Box flexDirection="column" padding={2}>
        <Box marginBottom={1}>
          <Text bold color="cyan">◆ Configure {editing.label}</Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>Paste your API key — saved to ~/.gates/config.json</Text>
        </Box>
        <Box>
          <Text color="cyan">❯ </Text>
          <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSave} placeholder="sk-..." mask="*" />
        </Box>
        <Box marginTop={1}><Text dimColor>↵ save  Esc cancel</Text></Box>
      </Box>
    );
  }

  // ── Main config screen ───────────────────────────────────────────────────────

  const providersDone = providers.filter((p) => p.configured).length;
  const connectorsDone = connectors.filter((c) => c.authenticated).length;

  return (
    <Box flexDirection="column" padding={2}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">◆ gates — Configuration</Text>
      </Box>

      {/* Tabs */}
      <Box marginBottom={1}>
        <Box
          borderStyle="single"
          paddingX={1}
          borderColor={tab === "providers" ? "cyan" : "gray"}
        >
          <Text color={tab === "providers" ? "cyan" : "white"}>
            AI Providers {providersDone}/{providers.length}
          </Text>
        </Box>
        <Text dimColor>  </Text>
        <Box
          borderStyle="single"
          paddingX={1}
          borderColor={tab === "connectors" ? "cyan" : "gray"}
        >
          <Text color={tab === "connectors" ? "cyan" : "white"}>
            Connectors {connectorsDone}/{connectors.length}
          </Text>
        </Box>
        <Text dimColor>  Tab to switch</Text>
      </Box>

      {/* Providers tab */}
      {tab === "providers" && (
        <Box flexDirection="column" paddingLeft={1}>
          {providers.map((p, i) => {
            const isSelected = selected === i;
            return (
              <Box key={p.id} marginBottom={1}>
                <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "▶ " : "  "}</Text>
                <Text color={p.configured ? "green" : "white"}>
                  {p.configured ? "✓" : "✗"}
                </Text>
                <Text bold={isSelected}> {p.label.padEnd(12)}</Text>
                {p.configured ? (
                  <Text dimColor>{p.source === "env" ? `$${p.envVar}` : "~/.gates/config.json"}</Text>
                ) : (
                  <Text color="yellow">press ↵ to add key</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Connectors tab */}
      {tab === "connectors" && (
        <Box flexDirection="column" paddingLeft={1}>
          {loadingConnectors ? (
            <Text dimColor>Checking installed CLI tools…</Text>
          ) : (
            connectors.map((c, i) => {
              const isSelected = selected === i;
              const status = !c.installed ? "not_installed"
                : !c.authenticated ? "not_authenticated"
                : "ready";

              return (
                <Box key={c.id} flexDirection="column" marginBottom={1}>
                  <Box>
                    <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "▶ " : "  "}</Text>
                    <Text color={status === "ready" ? "green" : status === "not_authenticated" ? "yellow" : "red"}>
                      {status === "ready" ? "✓" : status === "not_authenticated" ? "⚠" : "✗"}
                    </Text>
                    <Text bold={isSelected}> {c.label.padEnd(28)}</Text>
                    {status === "ready" && c.user && <Text dimColor>{c.user}</Text>}
                    {status === "ready" && c.version && <Text dimColor>  {c.version}</Text>}
                  </Box>
                  {isSelected && (
                    <Box paddingLeft={4} flexDirection="column">
                      <Text dimColor>{c.description}</Text>
                      {status === "not_installed" && (
                        <Box marginTop={0}>
                          <Text color="yellow">Install: </Text>
                          <Text>{c.installCmd}</Text>
                        </Box>
                      )}
                      {status === "not_authenticated" && (
                        <Box marginTop={0}>
                          <Text color="yellow">Authenticate: </Text>
                          <Text>{c.authCmd}</Text>
                        </Box>
                      )}
                    </Box>
                  )}
                </Box>
              );
            })
          )}
        </Box>
      )}

      {/* Message / feedback */}
      {message && (
        <Box marginTop={1} paddingLeft={2}>
          <Text color="cyan">{message}</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          {tab === "providers"
            ? "↑↓ navigate  ↵ add key  Tab connectors  Esc back"
            : "↑↓ navigate  ↵ show command  r refresh  Tab providers  Esc back"}
        </Text>
      </Box>
    </Box>
  );
}
