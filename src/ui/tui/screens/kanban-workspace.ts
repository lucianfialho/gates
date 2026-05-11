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
import type { KanbanCard, CardStatus } from "../shared/kanban-store.js";

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

const COL_ORDER: CardStatus[] = ["todo", "in-progress", "done"];
const COL_LABELS: Record<CardStatus, string> = {
  "todo": "○ TODO",
  "in-progress": "◑ IN PROGRESS",
  "done": "● DONE",
};

export class KanbanWorkspace {
  root: BoxRenderable;
  private renderer: CliRenderer;
  private syntaxStyle: SyntaxStyle;
  private keyHandler: (key: { name: string; ctrl: boolean; shift: boolean }) => void;

  // Navigation state
  private selectedCol = 0;
  private selectedRow = 0;

  // Column card boxes (for re-rendering selection state)
  private colCardBoxes: BoxRenderable[][] = [[], [], []];
  private colScrollBoxes: ScrollBoxRenderable[] = [];
  private colHeaderTexts: TextRenderable[] = [];

  // Chat area
  private chatMessagesBox: ScrollBoxRenderable;
  private chatInput: InputRenderable;
  private chatStatusText: TextRenderable;
  private sseBuffer = "";
  private abortController: AbortController | null = null;
  private kanbanSessionId = "";

  constructor(
    _ctx: unknown,
    renderer: CliRenderer,
    private onOpenCard: (card: KanbanCard) => void,
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

    // ── Columns area ─────────────────────────────────────────────────────
    const columnsArea = new BoxRenderable(renderer, {
      flexDirection: "row",
      flexGrow: 1,
    });
    this.root.add(columnsArea);

    for (let i = 0; i < 3; i++) {
      const status = COL_ORDER[i];
      const cards = kanbanStore.byStatus(status);

      const col = new BoxRenderable(renderer, {
        flexDirection: "column",
        flexGrow: 1,
        flexBasis: 0,
        border: ["right"],
        borderColor: "#333333",
      });

      // Column header
      const headerBox = new BoxRenderable(renderer, {
        height: 2,
        flexDirection: "row",
        paddingLeft: 1,
        border: ["bottom"],
        borderColor: "#333333",
      });
      const headerText = new TextRenderable(renderer, {
        content: `${COL_LABELS[status]}  ${cards.length}`,
        fg: "#ffffff",
        attributes: 1,
      });
      this.colHeaderTexts.push(headerText);
      headerBox.add(headerText);
      col.add(headerBox);

      // Cards scroll box
      const scrollBox = new ScrollBoxRenderable(renderer, {
        flexGrow: 1,
        scrollY: true,
      });
      this.colScrollBoxes.push(scrollBox);
      col.add(scrollBox);
      columnsArea.add(col);

      this.colCardBoxes[i] = [];
    }

    // Initial render of all cards
    this.renderAllColumns();

    // ── Chat area ─────────────────────────────────────────────────────────
    const chatArea = new BoxRenderable(renderer, {
      flexDirection: "column",
      height: 6,
      flexShrink: 0,
    });
    this.root.add(chatArea);

    // Separator line
    const separator = new TextRenderable(renderer, {
      content: "─".repeat(W),
      fg: "#333333",
    });
    chatArea.add(separator);

    // Chat history
    this.chatMessagesBox = new ScrollBoxRenderable(renderer, {
      height: 2,
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
      paddingTop: 0,
      paddingBottom: 0,
    });

    this.chatInput = new InputRenderable(renderer, {
      placeholder: "sobre o kanban todo…",
      flexGrow: 1,
    });
    this.chatInput.on(InputRenderableEvents.ENTER, () => {
      const text = this.chatInput.value.trim();
      if (!text) return;
      this.chatInput.value = "";
      void this.sendKanbanMessage(text);
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
      content: "←→ colunas  ↑↓ cards  enter abre  esc sai",
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
      if (key.name === "left") { this.moveCol(-1); return; }
      if (key.name === "right") { this.moveCol(1); return; }
      if (key.name === "up") { this.moveRow(-1); return; }
      if (key.name === "down") { this.moveRow(1); return; }
      if (key.name === "return") { this.openSelected(); return; }
    };
    renderer.keyInput.on("keypress", this.keyHandler);

    // Create a kanban session lazily
    void this.initKanbanSession();
  }

  private async initKanbanSession(): Promise<void> {
    try {
      const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/default-session`, { method: "POST" });
      const data = await res.json() as { sessionId: string };
      this.kanbanSessionId = data.sessionId;
    } catch {
      // session creation failed, chat will show error when used
    }
  }

  private getColCards(colIdx: number): KanbanCard[] {
    return kanbanStore.byStatus(COL_ORDER[colIdx]);
  }

  private renderAllColumns(): void {
    for (let i = 0; i < 3; i++) {
      this.renderColumn(i);
    }
  }

  private renderColumn(colIdx: number): void {
    const scrollBox = this.colScrollBoxes[colIdx];
    if (!scrollBox) return;

    // Remove existing card boxes
    for (const box of this.colCardBoxes[colIdx]) {
      try { scrollBox.remove(box.id); } catch { /* ignore */ }
    }
    this.colCardBoxes[colIdx] = [];

    const cards = this.getColCards(colIdx);
    const status = COL_ORDER[colIdx];

    // Update header count
    const headerText = this.colHeaderTexts[colIdx];
    if (headerText) {
      headerText.content = `${COL_LABELS[status]}  ${cards.length}`;
    }

    for (let rowIdx = 0; rowIdx < cards.length; rowIdx++) {
      const card = cards[rowIdx];
      const isSelected = this.selectedCol === colIdx && this.selectedRow === rowIdx;
      const sevColor = SEVERITY_COLORS[card.severity] ?? "#888888";
      const borderColor = isSelected ? "#00d4ff" : sevColor;

      const cardBox = new BoxRenderable(this.renderer, {
        flexDirection: "column",
        border: ["left"],
        customBorderChars: {
          topLeft: " ", topRight: " ", bottomLeft: " ", bottomRight: " ",
          horizontal: " ", vertical: "┃", topT: " ", bottomT: " ",
          leftT: " ", rightT: " ", cross: " ",
        },
        borderColor,
        paddingLeft: 2,
        paddingTop: 1,
        paddingBottom: 1,
      });

      const prefix = isSelected ? "▶ " : "  ";
      const titleText = new TextRenderable(this.renderer, {
        content: prefix + card.title,
        fg: isSelected ? "#00d4ff" : "#ffffff",
        attributes: isSelected ? 1 : 0,
      });
      cardBox.add(titleText);

      const metaText = new TextRenderable(this.renderer, {
        content: `${card.severity} · ${card.labels[0] ?? ""}`,
        fg: "#555555",
      });
      cardBox.add(metaText);

      scrollBox.add(cardBox);
      this.colCardBoxes[colIdx].push(cardBox);
    }
  }

  private moveCol(delta: number): void {
    const newCol = Math.max(0, Math.min(2, this.selectedCol + delta));
    if (newCol === this.selectedCol) return;
    const oldCol = this.selectedCol;
    this.selectedCol = newCol;
    this.selectedRow = 0;
    this.renderColumn(oldCol);
    this.renderColumn(this.selectedCol);
  }

  private moveRow(delta: number): void {
    const cards = this.getColCards(this.selectedCol);
    if (cards.length === 0) return;
    const newRow = Math.max(0, Math.min(cards.length - 1, this.selectedRow + delta));
    if (newRow === this.selectedRow) return;
    this.selectedRow = newRow;
    this.renderColumn(this.selectedCol);
  }

  private openSelected(): void {
    const cards = this.getColCards(this.selectedCol);
    const card = cards[this.selectedRow];
    if (card) {
      this.onOpenCard(card);
    }
  }

  private addChatMessage(role: "user" | "assistant", content: string): void {
    const row = new BoxRenderable(this.renderer, {
      flexDirection: "row",
      paddingLeft: 1,
    });
    const label = new TextRenderable(this.renderer, {
      content: role === "user" ? "You: " : "gates: ",
      fg: role === "user" ? "#00d4ff" : "#4a9eff",
      attributes: 1,
    });
    const body = new TextRenderable(this.renderer, {
      content,
      fg: "#cccccc",
    });
    row.add(label);
    row.add(body);
    this.chatMessagesBox.add(row);
  }

  private buildKanbanContext(userMessage: string): string {
    const cards = kanbanStore.cards;
    const todo = kanbanStore.byStatus("todo");
    const ip = kanbanStore.byStatus("in-progress");
    const done = kanbanStore.byStatus("done");
    const context = `[KANBAN: ${cards.length} tasks | TODO: ${todo.length} | IN PROGRESS: ${ip.length} | DONE: ${done.length}\n${todo.map(c => `- ${c.title} (${c.severity})`).join("\n")}]`;
    return `${context}\n\n${userMessage}`;
  }

  private async sendKanbanMessage(text: string): Promise<void> {
    if (!this.kanbanSessionId) {
      this.addChatMessage("assistant", "Aguardando sessão…");
      return;
    }
    this.addChatMessage("user", text);
    this.chatStatusText.content = "thinking…";
    this.abortController = new AbortController();

    const contextualMessage = this.buildKanbanContext(text);

    // Inline streaming assistant response in chat
    const responseRow = new BoxRenderable(this.renderer, {
      flexDirection: "row",
      paddingLeft: 1,
    });
    const responseLabel = new TextRenderable(this.renderer, {
      content: "gates: ",
      fg: "#4a9eff",
      attributes: 1,
    });
    const responseMd = new MarkdownRenderable(this.renderer, {
      content: "",
      streaming: true,
      syntaxStyle: this.syntaxStyle,
    });
    responseRow.add(responseLabel);
    responseRow.add(responseMd);
    this.chatMessagesBox.add(responseRow);

    let fullContent = "";
    try {
      const res = await fetch(
        `http://localhost:${DEFAULT_PORT}/api/sessions/${this.kanbanSessionId}/chat`,
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
              responseMd.content = fullContent;
            } else if (type === "done") {
              const finalContent = (d.content as string) ?? fullContent;
              responseMd.content = finalContent;
              responseMd.streaming = false;
            } else if (type === "tool_call") {
              this.chatStatusText.content = `⟳ ${d.name as string}`;
            }
          }
        }
      } finally {
        reader?.cancel().catch(() => {});
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        responseMd.content = `Error: ${(err as Error).message}`;
        responseMd.streaming = false;
      } else {
        responseMd.streaming = false;
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
