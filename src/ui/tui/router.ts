import type { CliRenderer } from "@opentui/core";
import type { LoadedHarness } from "../harness/loader.js";
import { DEFAULT_PORT } from "../server/index.js";
import { kanbanStore } from "./shared/kanban-store.js";
import type { KanbanCard } from "./shared/kanban-store.js";

export class AppRouter {
  private current: { destroy(): void } | null = null;
  constructor(private renderer: CliRenderer, private harnesses: LoadedHarness[]) {}

  async init() {
    kanbanStore.load();
    if (kanbanStore.cards.length === 0) {
      this.loadDemoCards();
    }
    await this.showKanban();
  }

  async showKanban() {
    this.current?.destroy();
    const { KanbanWorkspace } = await import("./screens/kanban-workspace.js");
    const screen = new KanbanWorkspace(
      this.renderer,
      this.renderer,
      (card: KanbanCard) => this.showCard(card),
      () => this.renderer.destroy(),
    );
    this.renderer.root.add(screen.root);
    this.current = screen;
  }

  async showCard(card: KanbanCard) {
    this.current?.destroy();
    const { CardView } = await import("./screens/card-view.js");
    const screen = new CardView(
      this.renderer,
      this.renderer,
      card,
      () => this.showKanban(),
    );
    this.renderer.root.add(screen.root);
    this.current = screen;
  }

  async showHarnessSelect() {
    this.current?.destroy();
    const { HarnessSelectScreen } = await import("./screens/harness-select.js");
    const ctx = this.renderer;
    const s = new HarnessSelectScreen(ctx, this.renderer, this.harnesses,
      (h, id) => this.showChat(h, id));
    this.renderer.root.add(s.root);
    this.current = s;
  }

  async showChat(harness: LoadedHarness, sessionId: string) {
    this.current?.destroy();
    const { ChatScreen } = await import("./screens/chat.js");
    const ctx = this.renderer;
    const s = new ChatScreen(ctx, this.renderer, harness, sessionId,
      () => this.showHarnessSelect());
    this.renderer.root.add(s.root);
    this.current = s;
  }

  private loadDemoCards() {
    kanbanStore.addCard({
      id: "1",
      title: "Fix EISDIR sandbox crash",
      body: "sandbox listDir throws on files instead of returning an error. The function should handle the case where the path is a file rather than a directory.",
      file: "packages/sandbox/src/index.ts",
      line: 306,
      snippet: "throw e; // bug",
      severity: "high",
      labels: ["bug"],
      status: "todo",
    });
    kanbanStore.addCard({
      id: "2",
      title: "Migrate TUI to OpenTUI",
      body: "Replace Ink with @opentui/core for the terminal UI. OpenTUI provides better performance and more rendering primitives.",
      file: null,
      line: null,
      snippet: null,
      severity: "medium",
      labels: ["feat"],
      status: "in-progress",
    });
    kanbanStore.addCard({
      id: "3",
      title: "Add streaming to Anthropic",
      body: "makeAnthropicProvider streaming support for incremental token delivery.",
      file: "packages/providers/src/anthropic/index.ts",
      line: 163,
      snippet: "stream: true",
      severity: "medium",
      labels: ["feat"],
      status: "done",
    });
    kanbanStore.save();
  }
}
