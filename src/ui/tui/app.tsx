import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { HarnessSelect } from "./screens/harness-select.js";
import { Chat } from "./screens/chat.js";
import { SessionsList, type SessionInfo } from "./screens/sessions-list.js";
import { ConfigScreen } from "./screens/config.js";
import type { LoadedHarness } from "../harness/loader.js";
import { DEFAULT_PORT } from "../server/index.js";

type Screen = "checking" | "config" | "loading" | "select" | "sessions" | "chat";

interface Props {
  harnesses: LoadedHarness[];
}

export function App({ harnesses }: Props) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("checking");
  const [selectedHarness, setSelectedHarness] = useState<LoadedHarness | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Show config on first launch or if nothing is configured
  useEffect(() => {
    Promise.all([
      fetch(`http://localhost:${DEFAULT_PORT}/api/auth/status`).then((r) => r.json()),
      fetch(`http://localhost:${DEFAULT_PORT}/api/first-launch`).then((r) => r.json()),
    ])
      .then(([statusData, launchData]: [unknown, unknown]) => {
        const status = statusData as { providers: Array<{ configured: boolean }> };
        const launch = launchData as { firstLaunch: boolean };
        const anyConfigured = status.providers.some((p) => p.configured);
        // Show config if: first launch ever, OR nothing configured at all
        setScreen(launch.firstLaunch || !anyConfigured ? "config" : "select");
      })
      .catch(() => setScreen("select")); // fail open
  }, []);

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input === "q") {
      if (screen === "select") exit();
    }
  });

  const startSession = async (harnessName: string, resumeSessionId?: string) => {
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
      const harness = harnesses.find((h) => h.name === harnessName) ?? harnesses[0]!;
      setSelectedHarness(harness);
      setSessionId(data.sessionId!);
      setScreen("chat");
    } catch (e) {
      setError(String(e));
      setScreen("select");
    }
  };

  const handleBack = () => {
    setScreen("select");
    setSelectedHarness(null);
    setSessionId(null);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (screen === "checking") {
    return (
      <Box padding={2}>
        <Text color="cyan">◆ </Text>
        <Text dimColor>Loading…</Text>
      </Box>
    );
  }

  if (screen === "config") {
    return (
      <ConfigScreen
        onDone={() => setScreen("select")}
        showSkipOption={true}
      />
    );
  }

  if (screen === "loading") {
    return (
      <Box padding={2}>
        <Text color="cyan">◆ </Text>
        <Text>Starting session…</Text>
      </Box>
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
        harnesses={harnesses}
        onSelect={(h) => startSession(h.name)}
        onOpenSessions={() => setScreen("sessions")}
        onOpenConfig={() => setScreen("config")}
      />
    );
  }

  if (screen === "sessions") {
    return (
      <SessionsList
        onResume={async (session: SessionInfo) => {
          const harness = harnesses.find((h) => h.name === session.harnessName) ?? harnesses[0]!;
          setSelectedHarness(harness);
          await startSession(session.harnessName, session.id);
        }}
        onBack={() => setScreen("select")}
      />
    );
  }

  if (screen === "chat" && selectedHarness && sessionId) {
    return (
      <Chat
        harness={selectedHarness}
        sessionId={sessionId}
        onBack={handleBack}
        onOpenSessions={() => setScreen("sessions")}
      />
    );
  }

  return null;
}
