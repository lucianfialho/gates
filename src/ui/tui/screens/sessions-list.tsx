import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { DEFAULT_PORT } from "../../server/index.js";

export interface SessionInfo {
  id: string;
  harnessName: string;
  messageCount: number;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

interface Props {
  onResume: (session: SessionInfo) => void;
  onBack: () => void;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SessionsList({ onResume, onBack }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetch(`http://localhost:${DEFAULT_PORT}/api/sessions`)
      .then((r) => r.json())
      .then((data: unknown) => {
        setSessions(Array.isArray(data) ? (data as SessionInfo[]) : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(sessions.length - 1, s + 1));
    if (key.return && sessions[selected]) onResume(sessions[selected]!);
    if (key.escape || input === "q") onBack();
    if (input === "d" && sessions[selected] && !deleting) {
      const sess = sessions[selected]!;
      setDeleting(sess.id);
      fetch(`http://localhost:${DEFAULT_PORT}/api/sessions/${sess.id}`, { method: "DELETE" })
        .then(() => {
          setSessions((prev) => prev.filter((s) => s.id !== sess.id));
          setSelected((s) => Math.min(s, sessions.length - 2));
          setDeleting(null);
        })
        .catch(() => setDeleting(null));
    }
  });

  if (loading) {
    return (
      <Box padding={2}><Text dimColor>Loading sessions…</Text></Box>
    );
  }

  return (
    <Box flexDirection="column" padding={2}>
      <Box marginBottom={1}>
        <Text bold color="cyan">◆ Sessions</Text>
        <Text dimColor>  {sessions.length === 0 ? "no sessions yet" : `${sessions.length} session(s)`}</Text>
      </Box>

      {sessions.length === 0 ? (
        <Box marginBottom={1}>
          <Text dimColor>Start a chat to create your first session.</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {sessions.map((sess, i) => {
            const isSelected = i === selected;
            const isDeleting = deleting === sess.id;
            return (
              <Box key={sess.id} flexDirection="column" marginBottom={1}>
                <Box>
                  <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "▶ " : "  "}</Text>
                  <Text bold={isSelected} color={isSelected ? "white" : "white"}>
                    {sess.harnessName}
                  </Text>
                  <Text dimColor>  {sess.messageCount} msg{sess.messageCount !== 1 ? "s" : ""}</Text>
                  <Text dimColor>  {relativeTime(sess.updatedAt)}</Text>
                  {isDeleting && <Text color="red">  deleting…</Text>}
                </Box>
                <Box paddingLeft={4}>
                  <Text dimColor wrap="truncate-end">
                    {sess.preview || <Text italic>no messages</Text>}
                  </Text>
                </Box>
                <Box paddingLeft={4}>
                  <Text color="gray">{sess.id.slice(0, 8)}…</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate  ↵ resume  d delete  Esc back</Text>
      </Box>
    </Box>
  );
}
