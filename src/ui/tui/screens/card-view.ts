import {
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { DEFAULT_PORT } from "../../server/index.js";
import { parseSseChunk } from "../shared/sse.js";
import { kanbanStore } from "../shared/kanban-store.js";
import type { KanbanCard } from "../shared/kanban-store.js";

const LEFT_BORDER = {
  topLeft: " ", topRight: " ", bottomLeft: " ", bottomRight: " ",
  horizontal: " ", vertical: "┃", topT: " ", bottomT: " ",
  leftT: " ", rightT: " ", cross: " ",
};

const SEVERITY_COLORS: Record<string, string> = {
  high: "#ff5555", medium: "#ffbb00", low: "#888888",
};

export class CardView {
  root: BoxRenderable;
  private renderer: CliRenderer;
  private syntaxStyle: SyntaxStyle;
  private keyHandler: (key: { name: string; ctrl: boolean }) => void;
  private chatInput: InputRenderable;
  private lastResponseText: TextRenderable;  // single-line preview
  private chatStatusText: TextRenderable;
  private sseBuffer = "";
  private abortController: AbortController | null = null;
  private sessionId = "";
  private chatHistory: Array<{ role: string; content: string }> = [];

  constructor(
    _ctx: unknown,
    renderer: CliRenderer,
    private card: KanbanCard,
    private onBack: () => void,
  ) {
    this.renderer = renderer;
    this.syntaxStyle = SyntaxStyle.create();

    const W = process.stdout.columns ?? 80;
    const H = process.stdout.rows ?? 24;
    const sevColor = SEVERITY_COLORS[card.severity] ?? "#888888";

    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: W,
      height: H,
    });

    process.stdout.on("resize", () => {
      (this.root as unknown as { width: number; height: number }).width  = process.stdout.columns ?? 80;
      (this.root as unknown as { width: number; height: number }).height = process.stdout.rows ?? 24;
    });

    // ── 1. Header — 1 row ─────────────────────────────────────────────
    const header = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      paddingLeft: 2,
      paddingRight: 2,
    });
    header.add(new TextRenderable(renderer, {
      content: `◆ gates  ›  ${card.title.slice(0, 45)}`,
      fg: "#aaaaaa",
      flexGrow: 1,
    }));
    header.add(new TextRenderable(renderer, {
      content: `${card.status.toUpperCase()}  ●  ${card.severity}`,
      fg: sevColor,
    }));
    this.root.add(header);

    // ── 2. Separator ─────────────────────────────────────────────────
    this.root.add(new TextRenderable(renderer, { content: "─".repeat(W), fg: "#333333" }));

    // ── 3. Card body — flexGrow:1 (takes all available space) ────────
    const cardScroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: false,
    });

    const inner = new BoxRenderable(renderer, {
      flexDirection: "column",
      paddingLeft: 3,
      paddingRight: 3,
      paddingTop: 1,
      paddingBottom: 1,
    });

    // Title (bold, large)
    inner.add(new TextRenderable(renderer, {
      content: card.title,
      fg: "#ffffff",
      attributes: 1,
    }));

    // Spacer
    inner.add(new TextRenderable(renderer, { content: " ", fg: "#000000" }));

    // Body markdown
    inner.add(new MarkdownRenderable(renderer, {
      content: card.body,
      syntaxStyle: this.syntaxStyle,
    }));

    // File reference
    if (card.file) {
      inner.add(new TextRenderable(renderer, { content: " ", fg: "#000000" }));
      const fileLine = card.line != null ? `${card.file}:${card.line}` : card.file;
      inner.add(new TextRenderable(renderer, {
        content: `📄  ${fileLine}`,
        fg: "#555555",
      }));
    }

    // Snippet with severity-colored ┃
    if (card.snippet) {
      inner.add(new TextRenderable(renderer, { content: " ", fg: "#000000" }));
      const snippetBox = new BoxRenderable(renderer, {
        flexDirection: "column",
        border: ["left"],
        customBorderChars: LEFT_BORDER,
        borderColor: sevColor,
        paddingLeft: 2,
      });
      for (const line of card.snippet.split("\n")) {
        snippetBox.add(new TextRenderable(renderer, { content: line, fg: "#777777" }));
      }
      inner.add(snippetBox);
    }

    // Labels
    inner.add(new TextRenderable(renderer, { content: " ", fg: "#000000" }));
    inner.add(new TextRenderable(renderer, {
      content: [card.severity, ...card.labels].join("  ·  "),
      fg: "#444444",
    }));

    cardScroll.add(inner);
    this.root.add(cardScroll);

    // ── 4. Separator ─────────────────────────────────────────────────
    this.root.add(new TextRenderable(renderer, { content: "─".repeat(W), fg: "#333333" }));

    // ── 5. Last response preview — 1 row ─────────────────────────────
    const previewRow = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      paddingLeft: 2,
    });
    this.chatStatusText = new TextRenderable(renderer, {
      content: "",
      fg: "#888888",
      flexGrow: 1,
    });
    this.lastResponseText = new TextRenderable(renderer, {
      content: "  Tab para histórico completo",
      fg: "#444444",
      flexGrow: 1,
    });
    previewRow.add(this.chatStatusText);
    previewRow.add(this.lastResponseText);
    this.root.add(previewRow);

    // ── 6. Separator ─────────────────────────────────────────────────
    this.root.add(new TextRenderable(renderer, { content: "─".repeat(W), fg: "#333333" }));

    // ── 7. Input row ─────────────────────────────────────────────────
    const inputRow = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      border: ["left"],
      customBorderChars: LEFT_BORDER,
      borderColor: "#4a9eff",
      paddingLeft: 2,
      paddingRight: 1,
      marginLeft: 2,
    });
    this.chatInput = new InputRenderable(renderer, {
      placeholder: "sobre esta task…",
      flexGrow: 1,
    });
    this.chatInput.on(InputRenderableEvents.ENTER, () => {
      const text = this.chatInput.value.trim();
      if (!text) return;
      this.chatInput.value = "";
      void this.sendMessage(text);
    });
    inputRow.add(this.chatInput);
    this.root.add(inputRow);

    // ── 8. Hints row ─────────────────────────────────────────────────
    const hintsRow = new BoxRenderable(renderer, {
      height: 1,
      paddingLeft: 3,
      flexDirection: "row",
      justifyContent: "space-between",
    });
    hintsRow.add(new TextRenderable(renderer, { content: "esc voltar", fg: "#444444" }));
    hintsRow.add(new TextRenderable(renderer, { content: "i issue  /fix  /test", fg: "#444444" }));
    this.root.add(hintsRow);

    renderer.root.add(this.root);
    renderer.focusRenderable(this.chatInput);

    renderer.keyInput.on("keypress", this.keyHandler = (key) => {
      if (key.ctrl && key.name === "c") { renderer.destroy(); return; }
      if (key.name === "escape") { this.abortController?.abort(); onBack(); }
    });

    void this.initSession();
  }

  private async initSession(): Promise<void> {
    if (this.card.chatSessionId) {
      this.sessionId = this.card.chatSessionId;
      try {
        const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/sessions/${this.sessionId}/history`);
        if (res.ok) {
          const data = await res.json() as { messages?: Array<{ role: string; content: string }> };
          this.chatHistory = data.messages?.filter(m => m.role === "user" || m.role === "assistant") ?? [];
          const last = this.chatHistory.filter(m => m.role === "assistant").at(-1);
          if (last) this.showPreview(last.content);
        }
      } catch { /* ignore */ }
      return;
    }
    try {
      const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/default-session`, { method: "POST" });
      const data = await res.json() as { sessionId: string };
      this.sessionId = data.sessionId;
      kanbanStore.setSessionId(this.card.id, this.sessionId);
      this.card.chatSessionId = this.sessionId;
    } catch { /* ignore */ }
  }

  private showPreview(content: string): void {
    // Show first line of response, truncated to fit
    const W = process.stdout.columns ?? 80;
    const firstLine = content.split("\n").find(l => l.trim()) ?? content;
    const preview = firstLine.length > W - 8 ? firstLine.slice(0, W - 11) + "…" : firstLine;
    this.lastResponseText.content = `  gates: ${preview}`;
    this.lastResponseText.fg = "#aaaaaa";
  }

  private async sendMessage(text: string): Promise<void> {
    if (!this.sessionId) return;

    this.chatStatusText.content = "thinking…";
    this.lastResponseText.content = "";
    this.abortController = new AbortController();
    this.chatHistory.push({ role: "user", content: text });

    const context = `[TASK: ${this.card.title} | ${this.card.severity}${this.card.file ? ` | ${this.card.file}:${this.card.line ?? ""}` : ""}\n${this.card.body.slice(0, 400)}]\n\n${text}`;

    let full = "";
    try {
      const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/sessions/${this.sessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: context }),
        signal: this.abortController.signal,
      });
      const reader = res.body?.getReader();
      const dec = new TextDecoder();
      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          const { buffer, events } = parseSseChunk(this.sseBuffer, dec.decode(value, { stream: true }));
          this.sseBuffer = buffer;
          for (const { type, data } of events) {
            const d = data as Record<string, unknown>;
            if (type === "delta") {
              full += (d.text as string) ?? "";
              // Show streaming in preview row
              const W2 = process.stdout.columns ?? 80;
              const streaming = full.split("\n").find(l => l.trim()) ?? full;
              this.lastResponseText.content = "  " + streaming.slice(0, W2 - 6) + (full.length > W2 - 6 ? "…" : "");
              this.lastResponseText.fg = "#888888";
            } else if (type === "done") {
              full = (d.content as string) ?? full;
              this.chatHistory.push({ role: "assistant", content: full });
              this.showPreview(full);
            } else if (type === "tool_call") {
              this.chatStatusText.content = `⟳ ${(d.name as string)}`;
            } else if (type === "tool_result") {
              this.chatStatusText.content = "thinking…";
            }
          }
        }
      } finally { reader?.cancel().catch(() => {}); }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.lastResponseText.content = `  Error: ${(err as Error).message}`;
      }
    }
    this.chatStatusText.content = "";
    this.renderer.focusRenderable(this.chatInput);
  }

  destroy(): void {
    this.abortController?.abort();
    this.renderer.keyInput.off("keypress", this.keyHandler);
    process.stdout.removeAllListeners("resize");
    this.root.destroy();
  }
}
