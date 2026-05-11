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

const STATUS_LABELS: Record<string, string> = {
  "todo": "TODO",
  "in-progress": "IN PROGRESS",
  "done": "DONE",
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
  private keyHandler: (key: { name: string; ctrl: boolean; shift: boolean }) => void;

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

    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: W,
      height: H,
    });

    const onResize = () => {
      (this.root as BoxRenderable & { width: number; height: number }).width = process.stdout.columns ?? 80;
      (this.root as BoxRenderable & { width: number; height: number }).height = process.stdout.rows ?? 24;
    };
    process.stdout.on("resize", onResize);

    // ── Header ────────────────────────────────────────────────────────────
    const header = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      paddingLeft: 1,
      paddingRight: 1,
      border: ["bottom"],
      borderColor: "#333333",
    });

    const truncatedTitle = card.title.length > 40 ? card.title.slice(0, 40) : card.title;
    const statusLabel = STATUS_LABELS[card.status] ?? card.status;
    const sevColor = SEVERITY_COLORS[card.severity] ?? "#888888";

    const breadcrumb = new TextRenderable(renderer, {
      content: `◆ gates  ›  ${truncatedTitle}   ${statusLabel}  ●  ${card.severity}`,
      fg: "#cccccc",
    });
    header.add(breadcrumb);

    // Severity color indicator
    const sevIndicator = new TextRenderable(renderer, {
      content: `  [${card.severity}]`,
      fg: sevColor,
    });
    header.add(sevIndicator);

    this.root.add(header);

    // ── Card content area ─────────────────────────────────────────────────
    const contentHeight = Math.floor(H * 0.45);
    const cardContent = new ScrollBoxRenderable(renderer, {
      height: contentHeight,
      scrollY: true,
    });

    // Title
    const titleText = new TextRenderable(renderer, {
      content: card.title,
      fg: "#ffffff",
      attributes: 1,
      paddingLeft: 2,
      paddingTop: 1,
    });
    cardContent.add(titleText);

    // Body
    const bodyMd = new MarkdownRenderable(renderer, {
      content: card.body,
      syntaxStyle: this.syntaxStyle,
      paddingLeft: 2,
      paddingTop: 1,
    });
    cardContent.add(bodyMd);

    // File reference
    if (card.file) {
      const fileLine = card.line != null ? `${card.file}:${card.line}` : card.file;
      const fileRef = new TextRenderable(renderer, {
        content: `📄 ${fileLine}`,
        fg: "#555555",
        paddingLeft: 2,
        paddingTop: 1,
      });
      cardContent.add(fileRef);
    }

    // Snippet
    if (card.snippet) {
      const snippetLines = card.snippet.split("\n").map(l => `┃ ${l}`).join("\n");
      const snippetText = new TextRenderable(renderer, {
        content: snippetLines,
        fg: "#555555",
        paddingLeft: 4,
        paddingTop: 1,
      });
      cardContent.add(snippetText);
    }

    this.root.add(cardContent);

    // ── Divider ────────────────────────────────────────────────────────────
    const divider = new TextRenderable(renderer, {
      content: "─".repeat(W),
      fg: "#333333",
    });
    this.root.add(divider);

    // ── Chat area ─────────────────────────────────────────────────────────
    const chatArea = new BoxRenderable(renderer, {
      flexDirection: "column",
      flexGrow: 1,
    });
    this.root.add(chatArea);

    // Chat history
    this.chatMessagesBox = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    chatArea.add(this.chatMessagesBox);

    // Input box
    const inputBox = new BoxRenderable(renderer, {
      border: ["left"],
      customBorderChars: LEFT_BORDER,
      borderColor: "#4a9eff",
      paddingLeft: 2,
      paddingRight: 1,
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

    // Hints row
    const hintsRow = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      paddingLeft: 2,
      justifyContent: "space-between",
    });
    this.chatStatusText = new TextRenderable(renderer, {
      content: "",
      fg: "#888888",
    });
    const hints = new TextRenderable(renderer, {
      content: "esc voltar  i criar issue  /fix implementa",
      fg: "#555555",
    });
    hintsRow.add(this.chatStatusText);
    hintsRow.add(hints);
    chatArea.add(hintsRow);

    renderer.focusRenderable(this.chatInput);

    // ── Keys ─────────────────────────────────────────────────────────────
    this.keyHandler = (key: { name: string; ctrl: boolean; shift: boolean }) => {
      if (key.ctrl && key.name === "c") { renderer.destroy(); return; }
      if (key.name === "escape") { this.abortController?.abort(); onBack(); return; }
    };
    renderer.keyInput.on("keypress", this.keyHandler);

    // Initialize session
    void this.initSession();
  }

  private async initSession(): Promise<void> {
    if (this.card.chatSessionId) {
      this.sessionId = this.card.chatSessionId;
      // Load history
      try {
        const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/sessions/${this.sessionId}/history`);
        if (res.ok) {
          const data = await res.json() as { messages?: Array<{ role: string; content: string }> };
          for (const msg of data.messages ?? []) {
            if (msg.role === "user" || msg.role === "assistant") {
              this.addMessage(msg.role as "user" | "assistant", msg.content);
            }
          }
        }
      } catch {
        // ignore history load errors
      }
      return;
    }

    // Create a new session
    try {
      const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/default-session`, { method: "POST" });
      const data = await res.json() as { sessionId: string };
      this.sessionId = data.sessionId;
      kanbanStore.setSessionId(this.card.id, this.sessionId);
      this.card.chatSessionId = this.sessionId;
    } catch {
      // session creation failed
    }
  }

  private addMessage(role: "user" | "assistant", content: string): void {
    const row = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      border: role === "assistant" ? ["left"] : false,
      customBorderChars: role === "assistant" ? LEFT_BORDER : undefined,
      borderColor: role === "assistant" ? "#4a9eff" : undefined,
    });

    const label = new TextRenderable(this.renderer, {
      content: role === "user" ? "You" : "gates",
      fg: role === "user" ? "#00d4ff" : "#4a9eff",
      attributes: 1,
    });
    row.add(label);

    const body = new MarkdownRenderable(this.renderer, {
      content,
      syntaxStyle: this.syntaxStyle,
      paddingTop: 1,
    });
    row.add(body);
    this.chatMessagesBox.add(row);
  }

  private buildCardContext(userMessage: string): string {
    const context = `[CARD: ${this.card.title}\nfile: ${this.card.file ?? "N/A"}:${this.card.line ?? ""}\nseverity: ${this.card.severity}\n${this.card.body.slice(0, 500)}]`;
    return `${context}\n\n${userMessage}`;
  }

  private async sendMessage(text: string): Promise<void> {
    if (!this.sessionId) {
      this.addMessage("assistant", "Aguardando sessão…");
      return;
    }

    this.addMessage("user", text);
    this.chatStatusText.content = "thinking…";
    this.abortController = new AbortController();

    const contextualMessage = this.buildCardContext(text);

    const row = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      border: ["left"],
      customBorderChars: LEFT_BORDER,
      borderColor: "#4a9eff",
    });
    const label = new TextRenderable(this.renderer, {
      content: "gates",
      fg: "#4a9eff",
      attributes: 1,
    });
    const md = new MarkdownRenderable(this.renderer, {
      content: "",
      streaming: true,
      syntaxStyle: this.syntaxStyle,
      paddingTop: 1,
    });
    row.add(label);
    row.add(md);
    this.chatMessagesBox.add(row);

    let fullContent = "";
    try {
      const res = await fetch(
        `http://localhost:${DEFAULT_PORT}/api/sessions/${this.sessionId}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: contextualMessage }),
          signal: this.abortController.signal,
        },
      );

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          const { buffer, events } = parseSseChunk(this.sseBuffer, decoder.decode(value, { stream: true }));
          this.sseBuffer = buffer;
          for (const { type, data } of events) {
            const d = data as Record<string, unknown>;
            if (type === "delta") {
              fullContent += (d.text as string) ?? "";
              md.content = fullContent;
            } else if (type === "done") {
              const finalContent = (d.content as string) ?? fullContent;
              md.content = finalContent;
              md.streaming = false;
            } else if (type === "tool_call") {
              this.chatStatusText.content = `⟳ ${d.name as string}`;
            } else if (type === "tool_result") {
              this.chatStatusText.content = "thinking…";
            }
          }
        }
      } finally {
        reader?.cancel().catch(() => {});
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        md.content = `Error: ${(err as Error).message}`;
        md.streaming = false;
      } else {
        md.streaming = false;
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
