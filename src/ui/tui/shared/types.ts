export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  streaming?: boolean;
}

export interface ToolCallItem {
  id: string;
  name: string;
  args: string;
  output?: string;
  isError?: boolean;
  status: "running" | "done" | "error";
}

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

export interface ThinkingBlockData {
  id: string;
  text: string;
  durationMs: number;
  collapsed: boolean;
}
