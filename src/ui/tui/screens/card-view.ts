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
  high: "#ff5555",
  medium: "#ffff55",
  low: "#888888",
};

export class CardView {
  root: BoxRenderable;
  private renderer: CliRenderer;
  private syntaxStyle: SyntaxStyle;
  private keyHandler: (key: { name: string; ctrl: boolean }) => void;
  private chatInput: InputRenderable;
  private chatMessagesBox: ScrollBoxRenderable;
  private chatStatusText: TextRenderable;
  private sseBuffer = "";
  private abortController: AbortController | null = null;
  private sessionId = "";

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

    // ── Header (2 rows) ──────────────────────────────────────────────────
    const header = new BoxRenderable(renderer, {
      height: 2,
      flexDirection: "column",
      paddingLeft: 2,
    });

    const breadcrumb = new TextRenderable(renderer, {
      content: `◆ gates  ›  ${card.title.slice(0, 50)}`,
      fg: "#cccccc",
    });

    const meta = new TextRenderable(renderer, {
      content: `${card.status.toUpperCase()}  ●  ${card.severity}` +
               (card.file ? `   📄 ${card.file}${card.line != null ? `:${card.line}` : ""}` : ""),
      fg: sevColor,
    });

    header.add(breadcrumb);
    header.add(meta);
    this.root.add(header);

    // ── Separator ────────────────────────────────────────────────────────
    const sep1 = new TextRenderable(renderer, { content: "─".repeat(W), fg: "#333333" });
    this.root.add(sep1);

    // ── Card body (fixed height ~40% of screen) ───────────────────────
    const bodyHeight = Math.max(4, Math.floor(H * 0.38));
    const cardScroll = new ScrollBoxRenderable(renderer, {
      height: bodyHeight,
      scrollY: true,
    });

    // Body as markdown
    const bodyBox = new BoxRenderable(renderer, {
      flexDirection: "column",
      paddingLeft: 3,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
    });
    const bodyMd = new MarkdownRenderable(renderer, {
      content: card.body,
      syntaxStyle: this.syntaxStyle,
    });
    bodyBox.add(bodyMd);
    cardScroll.add(bodyBox);

    // Snippet (if any)
    if (card.snippet) {
      const snippetBox = new BoxRenderable(renderer, {
        flexDirection: "column",
        paddingLeft: 3,
        paddingBottom: 1,
        border: ["left"],
        customBorderChars: LEFT_BORDER,
        borderColor: sevColor,
      });
      const snippetText = new TextRenderable(renderer, {
        content: card.snippet,
        fg: "#888888",
      });
      snippetBox.add(snippetText);
      cardScroll.add(snippetBox);
    }

    this.root.add(cardScroll);

    // ── Separator ────────────────────────────────────────────────────────
    const sep2 = new TextRenderable(renderer, { content: "─".repeat(W), fg: "#333333" });
    this.root.add(sep2);

    // ── Chat area (remaining space) ───────────────────────────────────
    const chatArea = new BoxRenderable(renderer, {
      flexDirection: "column",
      flexGrow: 1,
    });

    this.chatMessagesBox = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    chatArea.add(this.chatMessagesBox);

    // Input
    const inputBox = new BoxRenderable(renderer, {
      flexShrink: 0,
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
    inputBox.add(this.chatInput);
    chatArea.add(inputBox);

    // Hints
    const hintsRow = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      paddingLeft: 2,
      justifyContent: "space-between",
      flexShrink: 0,
    });
    this.chatStatusText = new TextRenderable(renderer, { content: "", fg: "#888888" });
    const hints = new TextRenderable(renderer, {
      content: "esc voltar  i issue  /fix implementa",
      fg: "#555555",
    });
    hintsRow.add(this.chatStatusText);
    hintsRow.add(hints);
    chatArea.add(hintsRow);

    this.root.add(chatArea);

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
          for (const msg of data.messages ?? []) {
            if (msg.role === "user" || msg.role === "assistant") {
              this.addChatMessage(msg.role as "user" | "assistant", msg.content);
            }
          }
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

  private addChatMessage(role: "user" | "assistant", content: string): void {
    const row = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      border: role === "assistant" ? ["left"] : false,
      customBorderChars: role === "assistant" ? LEFT_BORDER : undefined,
      borderColor: role === "assistant" ? "#4a9eff" : undefined,
    });
    row.add(new TextRenderable(this.renderer, {
      content: role === "user" ? "You" : "gates",
      fg: role === "user" ? "#00d4ff" : "#4a9eff",
      attributes: 1,
    }));
    row.add(new MarkdownRenderable(this.renderer, {
      content,
      syntaxStyle: this.syntaxStyle,
    }));
    this.chatMessagesBox.add(row);
  }

  private async sendMessage(text: string): Promise<void> {
    if (!this.sessionId) return;

    this.addChatMessage("user", text);
    this.chatStatusText.content = "thinking…";
    this.abortController = new AbortController();

    const context = `[TASK: ${this.card.title} | ${this.card.severity} | ${this.card.file ?? ""}${this.card.line != null ? `:${this.card.line}` : ""}\n${this.card.body.slice(0, 400)}]\n\n${text}`;

    const row = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      paddingLeft: 2, paddingRight: 2, paddingTop: 1,
      border: ["left"], customBorderChars: LEFT_BORDER, borderColor: "#4a9eff",
    });
    row.add(new TextRenderable(this.renderer, { content: "gates", fg: "#4a9eff", attributes: 1 }));
    const md = new MarkdownRenderable(this.renderer, {
      content: "", streaming: true, syntaxStyle: this.syntaxStyle,
    });
    row.add(md);
    this.chatMessagesBox.add(row);

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
            if (type === "delta") { full += (d.text as string) ?? ""; md.content = full; }
            else if (type === "done") { md.content = (d.content as string) ?? full; md.streaming = false; }
            else if (type === "tool_call") this.chatStatusText.content = `⟳ ${d.name as string}`;
            else if (type === "tool_result") this.chatStatusText.content = "thinking…";
          }
        }
      } finally { reader?.cancel().catch(() => {}); }
    } catch (err) {
      if ((err as Error).name !== "AbortError") { md.content = `Error: ${(err as Error).message}`; }
      md.streaming = false;
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
