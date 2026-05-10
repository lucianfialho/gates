import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

// ── KanbanFinding type (mirrors @gatesai/runtime) ─────────────────────────────

export interface KanbanFinding {
  id: string;
  title: string;
  file: string | null;
  line: number | null;
  snippet: string | null;
  body: string;
  severity: "high" | "medium" | "low";
  labels: string[];
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  findings: KanbanFinding[];
  repo: string;
  onClose: () => void;
  onCreateIssue: (finding: KanbanFinding) => void;
  onCreateAll: (findings: KanbanFinding[]) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEVERITY_ORDER = ["high", "medium", "low"] as const;
type Severity = (typeof SEVERITY_ORDER)[number];

const severityColor: Record<Severity, string> = {
  high: "red",
  medium: "yellow",
  low: "gray",
};

const severityLabel: Record<Severity, string> = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
};

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function KanbanBoard({ findings, repo, onClose, onCreateIssue, onCreateAll }: Props) {
  const columns: Record<Severity, KanbanFinding[]> = {
    high:   findings.filter((f) => f.severity === "high"),
    medium: findings.filter((f) => f.severity === "medium"),
    low:    findings.filter((f) => f.severity === "low"),
  };

  const [colIndex, setColIndex] = useState<number>(() => {
    // Start on the first non-empty column
    const idx = SEVERITY_ORDER.findIndex((s) => columns[s].length > 0);
    return idx === -1 ? 0 : idx;
  });
  const [rowIndex, setRowIndex] = useState(0);

  const activeSeverity = SEVERITY_ORDER[colIndex] ?? "high";
  const activeColumn   = columns[activeSeverity];
  const safeRow        = Math.min(rowIndex, Math.max(0, activeColumn.length - 1));
  const selectedCard   = activeColumn[safeRow] ?? null;

  useInput((char, key) => {
    // Column navigation
    if (key.leftArrow) {
      const next = (colIndex - 1 + SEVERITY_ORDER.length) % SEVERITY_ORDER.length;
      setColIndex(next);
      setRowIndex(0);
      return;
    }
    if (key.rightArrow) {
      const next = (colIndex + 1) % SEVERITY_ORDER.length;
      setColIndex(next);
      setRowIndex(0);
      return;
    }

    // Card navigation within column
    if (key.upArrow && activeColumn.length > 0) {
      setRowIndex((r) => Math.max(0, r - 1));
      return;
    }
    if (key.downArrow && activeColumn.length > 0) {
      setRowIndex((r) => Math.min(activeColumn.length - 1, r + 1));
      return;
    }

    // Actions
    if (char === "i" && selectedCard) {
      onCreateIssue(selectedCard);
      return;
    }
    if (char === "a") {
      onCreateAll(findings);
      return;
    }
    if (key.escape) {
      onClose();
      return;
    }
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  if (findings.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
        <Text bold color="green">No issues found — codebase looks clean!</Text>
        <Box marginTop={1}>
          <Text dimColor>Esc  close</Text>
        </Box>
      </Box>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const colWidth = 24;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0}>
      {/* Header */}
      <Box paddingX={1} paddingBottom={1}>
        <Text bold color="cyan">Code Review — {repo}  </Text>
        <Text dimColor>{findings.length} finding{findings.length !== 1 ? "s" : ""}</Text>
      </Box>

      {/* Columns */}
      <Box flexDirection="row" paddingX={1} marginBottom={1}>
        {SEVERITY_ORDER.map((sev, ci) => {
          const isActive = ci === colIndex;
          const col      = columns[sev];
          const color    = severityColor[sev];

          return (
            <Box key={sev} flexDirection="column" width={colWidth} marginRight={2}>
              {/* Column header */}
              <Box marginBottom={0}>
                <Text color={color} bold={isActive}>
                  {isActive ? "◉ " : "○ "}
                </Text>
                <Text color={color} bold={isActive}>
                  {severityLabel[sev]} ({col.length})
                </Text>
              </Box>
              {/* Divider */}
              <Box marginBottom={1}>
                <Text color={isActive ? color : "gray"}>
                  {"─".repeat(colWidth - 2)}
                </Text>
              </Box>

              {/* Cards */}
              {col.length === 0 ? (
                <Text dimColor>  —</Text>
              ) : (
                col.map((card, ri) => {
                  const isSelected = isActive && ri === safeRow;
                  return (
                    <Box key={card.id} flexDirection="column" marginBottom={1}>
                      <Text
                        color={isSelected ? color : undefined}
                        bold={isSelected}
                        dimColor={!isSelected && !isActive}
                      >
                        {isSelected ? "▶ " : "  "}
                        {truncate(card.title, colWidth - 3)}
                      </Text>
                      {card.file && (
                        <Text dimColor>
                          {"    "}
                          {truncate(
                            card.file + (card.line ? `:${card.line}` : ""),
                            colWidth - 4
                          )}
                        </Text>
                      )}
                    </Box>
                  );
                })
              )}
            </Box>
          );
        })}
      </Box>

      {/* Detail panel */}
      {selectedCard && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          marginX={1}
          marginBottom={1}
        >
          {/* Title + location */}
          <Box marginBottom={0}>
            <Text bold color={severityColor[selectedCard.severity]}>
              {selectedCard.title}
            </Text>
          </Box>
          {selectedCard.file && (
            <Box>
              <Text dimColor>
                {selectedCard.file}
                {selectedCard.line ? `:${selectedCard.line}` : ""}
              </Text>
            </Box>
          )}

          {/* Snippet */}
          {selectedCard.snippet && (
            <Box
              marginTop={1}
              marginBottom={1}
              borderStyle="single"
              borderColor="gray"
              paddingX={1}
            >
              <Text dimColor>{selectedCard.snippet}</Text>
            </Box>
          )}

          {/* Body excerpt */}
          <Box marginTop={selectedCard.snippet ? 0 : 1}>
            <Text>{truncate(selectedCard.body.replace(/##\s*/g, "").replace(/\n+/g, "  "), 200)}</Text>
          </Box>
        </Box>
      )}

      {/* Footer */}
      <Box paddingX={1}>
        <Text dimColor>
          ↑↓ card  ←→ column  i issue  a all  Esc close
        </Text>
      </Box>
    </Box>
  );
}
