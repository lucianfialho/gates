import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface SessionMessage {
  role: string;
  content: string;
  timestamp: number;
}

interface SessionEntry {
  type: string;
  message?: SessionMessage;
}

interface Failure {
  sessionId: string;
  userAsked: string;
  agentSaid: string;
  pattern: string;
  category: "harness" | "connector_doc" | "tool" | "unknown";
}

// Patterns that indicate harness behavioral issues (not domain knowledge)
const HARNESS_FAILURE_PATTERNS = [
  { regex: /não tenho acesso|no access|sem acesso/i, label: "agent_refused_with_no_access" },
  { regex: /não está configurad|not configured/i, label: "agent_said_not_configured" },
  { regex: /oauth|autenticação.*requer|authentication required/i, label: "agent_asked_for_auth" },
  { regex: /não tenho integraç|no integration/i, label: "agent_denied_integration" },
  { regex: /você pode.*rodar|you can.*run|execute o comando/i, label: "agent_asked_user_to_run" },
  { regex: /preciso de mais contexto|need more context/i, label: "agent_asked_unnecessary_question" },
];

function loadSessions(dir: string, sinceMs?: number): Array<{ id: string; messages: SessionMessage[] }> {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((f) => f.startsWith("harness-ui_") && f.endsWith(".json"))
    .filter((f) => {
      if (!sinceMs) return true;
      const stat = fs.statSync(path.join(dir, f));
      return stat.mtimeMs > sinceMs;
    })
    .flatMap((f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as {
          entries?: SessionEntry[];
          metadata?: Record<string, string>;
        };
        const id = f.replace("harness-ui_", "").replace(".json", "").slice(0, 8);
        const messages = (data.entries ?? [])
          .filter((e) => e.type === "message" && e.message)
          .map((e) => e.message!);
        return messages.length > 0 ? [{ id, messages }] : [];
      } catch {
        return [];
      }
    });
}

function detectFailures(sessions: Array<{ id: string; messages: SessionMessage[] }>): Failure[] {
  const failures: Failure[] = [];

  for (const { id, messages } of sessions) {
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1];
      const curr = messages[i];

      if (curr.role !== "assistant" || prev?.role !== "user") continue;

      for (const { regex, label } of HARNESS_FAILURE_PATTERNS) {
        if (regex.test(curr.content)) {
          failures.push({
            sessionId: id,
            userAsked: prev.content.slice(0, 100),
            agentSaid: curr.content.slice(0, 150),
            pattern: label,
            category: "harness",
          });
          break;
        }
      }
    }
  }

  return failures;
}

function generateHarnessRule(failures: Failure[]): string {
  const grouped = failures.reduce((acc, f) => {
    acc[f.pattern] = (acc[f.pattern] ?? []).concat(f);
    return acc;
  }, {} as Record<string, Failure[]>);

  const rules: string[] = [];

  for (const [pattern, cases] of Object.entries(grouped)) {
    const example = cases[0]!;
    rules.push(`
# Pattern: ${pattern} (${cases.length} occurrences)
# User asked: "${example.userAsked}"
# Agent responded: "${example.agentSaid.slice(0, 80)}..."
# Proposed rule: Add to harness system prompt:
#   NEVER say "${example.agentSaid.slice(0, 50)}..." — this is wrong behavior
`);
  }

  return rules.join("\n");
}

export async function analyzeLoop(options: {
  interval?: number;
  onImprovement?: (suggestion: string) => void;
  once?: boolean;
}): Promise<void> {
  const sessionsDir = path.join(os.homedir(), ".gates", "sessions");
  const intervalMs = (options.interval ?? 30) * 1000;
  const reportFile = path.join(os.homedir(), ".gates", "harness-improvements.md");

  console.log(`\n◆ Gates Session Analyzer`);
  console.log(`  Monitoring: ${sessionsDir}`);
  console.log(`  Interval: ${intervalMs / 1000}s`);
  console.log(`  Report: ${reportFile}`);
  console.log(`  Press Ctrl+C to stop\n`);

  let lastCheck = Date.now() - intervalMs * 2; // check last 2 intervals on first run

  const check = () => {
    const sessions = loadSessions(sessionsDir, lastCheck);
    if (sessions.length === 0) {
      process.stdout.write(".");
      return;
    }

    const failures = detectFailures(sessions);
    lastCheck = Date.now();

    if (failures.length === 0) {
      process.stdout.write("✓");
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 19);
    const suggestion = `\n## ${timestamp} — ${failures.length} harness behavioral failure(s)\n${generateHarnessRule(failures)}`;

    // Append to report file
    fs.appendFileSync(reportFile, suggestion);

    console.log(`\n\n⚠ ${failures.length} harness failure(s) detected:`);
    for (const f of failures.slice(0, 3)) {
      console.log(`  [${f.sessionId}] ${f.pattern}`);
      console.log(`    User: "${f.userAsked.slice(0, 60)}"`);
      console.log(`    Agent: "${f.agentSaid.slice(0, 60)}"`);
    }
    console.log(`\n  Improvement suggestions written to: ${reportFile}`);

    options.onImprovement?.(suggestion);
  };

  check(); // run immediately

  if (options.once) return;

  const timer = setInterval(check, intervalMs);

  return new Promise((resolve) => {
    process.on("SIGINT", () => {
      clearInterval(timer);
      console.log("\n\n◆ Analyzer stopped.");
      resolve();
    });
  });
}
