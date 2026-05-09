import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Chat } from "./screens/chat.js";
import { HarnessSelect } from "./screens/harness-select.js";
import { SessionsList, type SessionInfo } from "./screens/sessions-list.js";
import { ConfigScreen } from "./screens/config.js";
import type { LoadedHarness } from "../harness/loader.js";
import { DEFAULT_PORT } from "../server/index.js";

// Synthetic default harness for the TUI (display only — server builds the real one)
const DEFAULT_HARNESS: LoadedHarness = {
  name: "Gates",
  dirPath: "",
  config: {
    name: "Gates",
    description: "Your AI development agent",
    provider: { type: "minimax" },
    tools: ["read", "write", "bash", "grep", "glob", "edit"],
  },
};

type Screen = "checking" | "config" | "loading" | "chat" | "select" | "sessions";

interface Props {
  harnesses: LoadedHarness[];
}

export function App({ harnesses }: Props) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("checking");
  const [selectedHarness, setSelectedHarness] = useState<LoadedHarness>(DEFAULT_HARNESS);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // On startup: check config, then open chat directly
  useEffect(() => {
    Promise.all([
      fetch(`http://localhost:${DEFAULT_PORT}/api/auth/status`).then((r) => r.json()),
      fetch(`http://localhost:${DEFAULT_PORT}/api/first-launch`).then((r) => r.json()),
    ])
      .then(async ([statusData, launchData]: [unknown, unknown]) => {
        const status = statusData as { providers: Array<{ configured: boolean }> };
        const launch = launchData as { firstLaunch: boolean };
        const anyConfigured = status.providers.some((p) => p.configured);

        if (launch.firstLaunch || !anyConfigured) {
          setScreen("config");
          return;
        }

        // Go straight to chat with the default session
        setScreen("loading");
        try {
          const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/default-session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          const data = await res.json() as { sessionId?: string; harnessName?: string };
          setSessionId(data.sessionId!);
          // Use a named harness if available, otherwise the default
          const namedHarness = harnesses.find((h) => h.name === data.harnessName);
          setSelectedHarness(namedHarness ?? DEFAULT_HARNESS);
          setScreen("chat");
        } catch (e) {
          setError(String(e));
          setScreen("select");
        }
      })
      .catch(() => setScreen("select"));
  }, []);

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input === "q") {
      if (screen === "select") exit();
    }
  });

  const startNamedSession = async (harnessName: string, resumeSessionId?: string) => {
    setScreen("loading");
    setError(null);
    try {
      const body = resumeSessionId ? { resumeSessionId } : { harnessName };
      const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { sessionId?: string; error?: string };
      if (data.error) throw new Error(data.error);
      const harness = harnesses.find((h) => h.name === harnessName) ?? DEFAULT_HARNESS;
      setSelectedHarness(harness);
      setSessionId(data.sessionId!);
      setScreen("chat");
    } catch (e) {
      setError(String(e));
      setScreen("select");
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (screen === "checking" || screen === "loading") {
    return (
      <Box padding={2}>
        <Text color="cyan">◆ </Text>
        <Text dimColor>{screen === "checking" ? "Loading…" : "Starting…"}</Text>
      </Box>
    );
  }

  if (screen === "config") {
    return (
      <ConfigScreen
        onDone={async () => {
          setScreen("loading");
          try {
            const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/default-session`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
            });
            const data = await res.json() as { sessionId?: string };
            setSessionId(data.sessionId!);
            setSelectedHarness(DEFAULT_HARNESS);
            setScreen("chat");
          } catch { setScreen("select"); }
        }}
        showSkipOption={true}
      />
    );
  }

  if (error) {
    return (
      <Box padding={2} flexDirection="column">
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press any key to continue</Text>
      </Box>
    );
  }

  if (screen === "select") {
    return (
      <HarnessSelect
        harnesses={harnesses.length > 0 ? harnesses : [DEFAULT_HARNESS]}
        onSelect={(h) => startNamedSession(h.name)}
        onOpenSessions={() => setScreen("sessions")}
        onOpenConfig={() => setScreen("config")}
      />
    );
  }

  if (screen === "sessions") {
    return (
      <SessionsList
        onResume={async (session: SessionInfo) => {
          await startNamedSession(session.harnessName, session.id);
        }}
        onBack={() => setScreen(sessionId ? "chat" : "select")}
      />
    );
  }

  if (screen === "chat" && sessionId) {
    return (
      <Chat
        harness={selectedHarness}
        sessionId={sessionId}
        onBack={() => setScreen("select")}
        onOpenSessions={() => setScreen("sessions")}
      />
    );
  }

  return null;
}
