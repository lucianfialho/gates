import type { CliRenderer } from "@opentui/core";
import type { LoadedHarness } from "../harness/loader.js";
import { DEFAULT_PORT } from "../server/index.js";

export class AppRouter {
  private current: { destroy(): void } | null = null;
  constructor(private renderer: CliRenderer, private harnesses: LoadedHarness[]) {}

  async init() {
    // Go directly to chat — create a default session and open it
    try {
      const res = await fetch(`http://localhost:${DEFAULT_PORT}/api/default-session`, { method: "POST" });
      const data = await res.json() as { sessionId: string; harnessName: string };
      const harness = this.harnesses.find(h => h.name === data.harnessName) ?? this.harnesses[0];
      if (harness && data.sessionId) {
        await this.showChat(harness, data.sessionId);
        return;
      }
    } catch { /* fall through to select */ }
    await this.showHarnessSelect();
  }

  async showHarnessSelect() {
    this.current?.destroy();
    const { HarnessSelectScreen } = await import("./screens/harness-select.js");
    // renderContext is the ctx for renderables, renderer is for focus/keys
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
}
