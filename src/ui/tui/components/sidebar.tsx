import React from "react";
import { Box, Text } from "ink";

export interface SidebarItem {
  label: string;
  status?: "pending" | "running" | "done" | "error";
  value?: string;
}

export interface SidebarSection {
  title: string;
  items: SidebarItem[];
}

export interface SidebarData {
  title?: string;
  meta?: Array<{ label: string; value: string }>;
  sections: SidebarSection[];
  progress?: { done: number; total: number; label?: string };
}

const STATUS_ICON: Record<NonNullable<SidebarItem["status"]>, string> = {
  pending: "○",
  running: "⟳",
  done:    "✓",
  error:   "✗",
};

const STATUS_COLOR: Record<NonNullable<SidebarItem["status"]>, string> = {
  pending: "gray",
  running: "yellow",
  done:    "green",
  error:   "red",
};

interface Props {
  data: SidebarData;
  width: number;
  height: number;
}

export function Sidebar({ data, width, height }: Props) {
  const maxLabel = width - 6;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderRight
      overflow="hidden"
    >
      {/* Title */}
      {data.title && (
        <Box paddingX={1} marginBottom={0}>
          <Text bold color="cyan" wrap="truncate">
            {data.title.slice(0, maxLabel)}
          </Text>
        </Box>
      )}

      {/* Metadata */}
      {data.meta && data.meta.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          {data.meta.map((m) => (
            <Box key={m.label}>
              <Text dimColor>{m.label}: </Text>
              <Text wrap="truncate">{m.value.slice(0, maxLabel - m.label.length - 2)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Progress bar */}
      {data.progress && (
        <Box paddingX={1} marginBottom={1}>
          <Text color="cyan">
            {data.progress.label ?? "Progress"}:{" "}
          </Text>
          <Text color="green">{data.progress.done}</Text>
          <Text dimColor>/{data.progress.total}</Text>
        </Box>
      )}

      {/* Sections */}
      {data.sections.map((section) => (
        <Box key={section.title} flexDirection="column" marginBottom={1}>
          <Box paddingX={1}>
            <Text bold dimColor>{section.title}</Text>
          </Box>
          {section.items.map((item, i) => (
            <Box key={i} paddingX={1} flexDirection="column">
              <Box>
                {item.status && (
                  <Text color={STATUS_COLOR[item.status]}>
                    {STATUS_ICON[item.status]}{" "}
                  </Text>
                )}
                <Text wrap="truncate" dimColor={item.status === "pending"}>
                  {item.label.slice(0, maxLabel - (item.status ? 2 : 0))}
                </Text>
              </Box>
              {item.value && item.status !== "pending" && (
                <Box paddingLeft={2}>
                  <Text dimColor wrap="truncate">
                    {item.value.slice(0, maxLabel - 2)}
                  </Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
