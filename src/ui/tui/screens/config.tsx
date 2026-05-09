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
  compatible?: boolean;
  error?: "not_installed" | "incompatible" | "not_authenticated" | null;
  fallbackAvailable?: boolean;
  fallbackInstallCmd?: string;
  fallbackAuthNote?: string;
  user: string | null;
  version: string | null;
  installCmd: string;
  authCmd: string;
}

interface ModelSlot {
  role: string;
  label: string;
  description: string;
  provider: string;
  model: string;
}

interface KnownModel { id: string; label: string; tier: "fast" | "balanced" | "powerful" }
interface ModelsConfig {
  slots: ModelSlot[];
  knownModels: Record<string, KnownModel[]>;
}

interface AuthStatus { providers: ProviderItem[] }
interface ConnectorStatus { connectors: ConnectorItem[] }

// ── Helpers ───────────────────────────────────────────────────────────────────

type TabId = "providers" | "connectors" | "models";

interface Props {
  onDone: () => void;
  showSkipOption?: boolean;
}

type EditingState =
  | { type: "provider"; id: string; label: string }
  | { type: "model_provider"; role: string; label: string; pickerIdx: number }
  | { type: "model_name"; role: string; label: string; provider: string; pickerIdx: number }
  | null;

// ── Component ─────────────────────────────────────────────────────────────────

export function ConfigScreen({ onDone, showSkipOption = false }: Props) {
  const [tab, setTab] = useState<TabId>("providers");
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [connectors, setConnectors] = useState<ConnectorItem[]>([]);
  const [modelsConfig, setModelsConfig] = useState<ModelsConfig | null>(null);
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

  const loadModels = useCallback(() => {
    fetch(`http://localhost:${DEFAULT_PORT}/api/config/models`)
      .then((r) => r.json())
      .then((d: unknown) => setModelsConfig(d as ModelsConfig))
      .catch(() => {});
  }, []);

  useEffect(() => { loadProviders(); loadConnectors(); loadModels(); }, [loadProviders, loadConnectors, loadModels]);

  const currentList = tab === "providers" ? providers
    : tab === "connectors" ? connectors
    : (modelsConfig?.slots ?? []);

  const PROVIDERS_LIST = ["anthropic", "minimax", "openai"];

  useInput((input, key) => {
    // ── Navigation inside pickers ──────────────────────────────────────────
    if (editing && editing.type === "model_provider") {
      if (key.upArrow)   setEditing({ ...editing, pickerIdx: Math.max(0, editing.pickerIdx - 1) });
      if (key.downArrow) setEditing({ ...editing, pickerIdx: Math.min(PROVIDERS_LIST.length - 1, editing.pickerIdx + 1) });
      if (key.escape)    setEditing(null);
      if (key.return) {
        const provider = PROVIDERS_LIST[editing.pickerIdx]!;
        setEditing({ type: "model_name", role: editing.role, label: editing.label, provider, pickerIdx: 0 });
      }
      return;
    }

    if (editing && editing.type === "model_name") {
      const models = modelsConfig?.knownModels[editing.provider] ?? [];
      if (key.upArrow)   setEditing({ ...editing, pickerIdx: Math.max(0, editing.pickerIdx - 1) });
      if (key.downArrow) setEditing({ ...editing, pickerIdx: Math.min(models.length - 1, editing.pickerIdx + 1) });
      if (key.escape)    setEditing({ type: "model_provider", role: editing.role, label: editing.label, pickerIdx: PROVIDERS_LIST.indexOf(editing.provider) });
      if (key.return) {
        const model = models[editing.pickerIdx];
        if (model) handleSaveModel(editing.role, editing.provider, model.id, editing.label);
      }
      return;
    }

    if (editing) return;

    if (key.tab || input === "\t") {
      setTab((t) => t === "providers" ? "connectors" : t === "connectors" ? "models" : "providers");
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

    if (input === "r" && tab === "connectors") { loadConnectors(); flash("Refreshing…"); }
    if (input === "r" && tab === "models") { loadModels(); }

    if (tab === "models" && key.return) {
      const slot = (modelsConfig?.slots ?? [])[selected];
      if (!slot) return;
      setEditing({
        type: "model_provider",
        role: slot.role,
        label: slot.label,
        pickerIdx: Math.max(0, PROVIDERS_LIST.indexOf(slot.provider)),
      });
    }
  });

  const handleSaveModel = async (role: string, provider: string, model: string, label: string) => {
    await fetch(`http://localhost:${DEFAULT_PORT}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section: "models", id: role, value: { provider, model } }),
    });
    flash(`✓ ${label} → ${provider}/${model}`);
    loadModels();
    setEditing(null);
  };

  const handleSave = async () => {
    if (!editing || !inputValue.trim()) { setEditing(null); return; }
    try {
      if (editing.type === "provider") {
        await fetch(`http://localhost:${DEFAULT_PORT}/api/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section: "providers", id: editing.id, value: inputValue.trim() }),
        });
        flash(`✓ ${editing.label} saved`);
        loadProviders();
      } else if (editing.type === "model_name") {
        await fetch(`http://localhost:${DEFAULT_PORT}/api/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section: "models", id: editing.role, value: { provider: editing.provider, model: inputValue.trim() } }),
        });
        flash(`✓ ${editing.label} → ${editing.provider}/${inputValue.trim()}`);
        loadModels();
      }
    } finally {
      setEditing(null);
    }
  };

  // ── Editing screens ───────────────────────────────────────────────────────────

  if (editing) {
    if (editing.type === "provider") {
      return (
        <Box flexDirection="column" padding={2}>
          <Box marginBottom={1}><Text bold color="cyan">◆ Configure {editing.label}</Text></Box>
          <Box marginBottom={1}><Text dimColor>Paste your API key — saved to ~/.gates/config.json</Text></Box>
          <Box><Text color="cyan">❯ </Text>
            <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSave} placeholder="sk-..." mask="*" />
          </Box>
          <Box marginTop={1}><Text dimColor>↵ save  Esc cancel</Text></Box>
        </Box>
      );
    }

    if (editing.type === "model_provider") {
      const list = ["anthropic", "minimax", "openai"];
      return (
        <Box flexDirection="column" padding={2}>
          <Box marginBottom={1}><Text bold color="cyan">◆ {editing.label} — Provider</Text></Box>
          <Box flexDirection="column">
            {list.map((p, i) => (
              <Box key={p}>
                <Text color={i === editing.pickerIdx ? "cyan" : undefined}>
                  {i === editing.pickerIdx ? "▶ " : "  "}
                </Text>
                <Text bold={i === editing.pickerIdx}>{p}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}><Text dimColor>↑↓ navigate  ↵ select  Esc back</Text></Box>
        </Box>
      );
    }

    if (editing.type === "model_name") {
      const models = modelsConfig?.knownModels[editing.provider] ?? [];
      const tierColor = (tier: string) => tier === "powerful" ? "magenta" : tier === "balanced" ? "cyan" : "green";
      return (
        <Box flexDirection="column" padding={2}>
          <Box marginBottom={1}><Text bold color="cyan">◆ {editing.label} — Model</Text></Box>
          <Box marginBottom={1}><Text dimColor>{editing.provider}</Text></Box>
          <Box flexDirection="column">
            {models.map((m, i) => (
              <Box key={m.id}>
                <Text color={i === editing.pickerIdx ? "cyan" : undefined}>
                  {i === editing.pickerIdx ? "▶ " : "  "}
                </Text>
                <Text bold={i === editing.pickerIdx}>{m.label.padEnd(28)}</Text>
                <Text color={tierColor(m.tier)}>{m.tier}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}><Text dimColor>↑↓ navigate  ↵ select  Esc back</Text></Box>
        </Box>
      );
    }
  }

  // ── Main config screen ───────────────────────────────────────────────────────

  const providersDone = providers.filter((p) => p.configured).length;
  const connectorsDone = connectors.filter((c) => c.authenticated).length;
  const slots = modelsConfig?.slots ?? [];

  return (
    <Box flexDirection="column" padding={2}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">◆ gates — Configuration</Text>
      </Box>

      {/* Tabs */}
      <Box marginBottom={1}>
        {([
          { id: "providers", label: `Providers ${providersDone}/${providers.length}` },
          { id: "connectors", label: `Connectors ${connectorsDone}/${connectors.length}` },
          { id: "models", label: `Models` },
        ] as Array<{ id: TabId; label: string }>).map(({ id, label }) => (
          <React.Fragment key={id}>
            <Box borderStyle="single" paddingX={1} borderColor={tab === id ? "cyan" : "gray"}>
              <Text color={tab === id ? "cyan" : "white"}>{label}</Text>
            </Box>
            <Text dimColor>  </Text>
          </React.Fragment>
        ))}
        <Text dimColor>Tab to switch</Text>
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
              const isIncompatible = c.error === "incompatible";
              const status = c.authenticated ? "ready"
                : isIncompatible ? "incompatible"
                : !c.installed ? "not_installed"
                : "not_authenticated";

              const statusIcon = status === "ready" ? "✓"
                : status === "incompatible" ? "⚡"
                : status === "not_authenticated" ? "⚠"
                : "✗";

              const statusColor = status === "ready" ? "green"
                : status === "incompatible" ? "magenta"
                : status === "not_authenticated" ? "yellow"
                : "red";

              return (
                <Box key={c.id} flexDirection="column" marginBottom={1}>
                  <Box>
                    <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "▶ " : "  "}</Text>
                    <Text color={statusColor}>{statusIcon}</Text>
                    <Text bold={isSelected}> {c.label.padEnd(26)}</Text>
                    {status === "ready" && c.user && <Text dimColor>{c.user}</Text>}
                    {status === "ready" && c.version && <Text dimColor>  {c.version}</Text>}
                    {status === "incompatible" && <Text color="magenta">binary incompatible with this Linux (GLIBC)</Text>}
                  </Box>
                  {isSelected && (
                    <Box paddingLeft={4} flexDirection="column">
                      <Text dimColor>{c.description}</Text>
                      {status === "not_installed" && (
                        <Box marginTop={0}>
                          <Text color="yellow">Install: </Text><Text>{c.installCmd}</Text>
                        </Box>
                      )}
                      {status === "not_authenticated" && (
                        <Box marginTop={0}>
                          <Text color="yellow">Authenticate: </Text><Text>{c.authCmd}</Text>
                        </Box>
                      )}
                      {status === "incompatible" && (
                        <Box flexDirection="column" marginTop={0}>
                          <Box>
                            <Text color="magenta">The gws binary requires a newer Linux (GLIBC 2.39+).</Text>
                          </Box>
                          <Box marginTop={0}>
                            <Text color="cyan">Alternative (Node.js, no binary needed):</Text>
                          </Box>
                          {c.fallbackInstallCmd && (
                            <Box><Text dimColor>  {c.fallbackInstallCmd}</Text></Box>
                          )}
                          {c.fallbackAuthNote && (
                            <Box><Text dimColor>  {c.fallbackAuthNote}</Text></Box>
                          )}
                          {c.fallbackAvailable && (
                            <Box marginTop={0}><Text color="green">✓ googleapis already available — set credentials to use</Text></Box>
                          )}
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

      {/* Models tab */}
      {tab === "models" && (
        <Box flexDirection="column" paddingLeft={1}>
          {slots.map((slot, i) => {
            const isSelected = selected === i;
            const tierColor = slot.model.includes("opus") || slot.model.includes("o3") ? "magenta"
              : slot.model.includes("haiku") || slot.model.includes("mini") ? "green"
              : "cyan";
            return (
              <Box key={slot.role} flexDirection="column" marginBottom={1}>
                <Box>
                  <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "▶ " : "  "}</Text>
                  <Text bold={isSelected} color="white">{slot.label.padEnd(12)}</Text>
                  <Text color={tierColor}>{slot.provider}</Text>
                  <Text dimColor>/</Text>
                  <Text color={tierColor}>{slot.model}</Text>
                </Box>
                {isSelected && (
                  <Box paddingLeft={4}>
                    <Text dimColor>{slot.description}</Text>
                  </Box>
                )}
              </Box>
            );
          })}
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
            ? "↑↓ navigate  ↵ add key  Tab → next  Esc back"
            : tab === "connectors"
            ? "↑↓ navigate  ↵ show command  r refresh  Tab → next  Esc back"
            : "↑↓ navigate  ↵ change model  Tab → next  Esc back"}
        </Text>
      </Box>
    </Box>
  );
}
