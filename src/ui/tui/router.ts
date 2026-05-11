import type { CliRenderer } from "@opentui/core";
import type { LoadedHarness } from "../harness/loader.js";

export class AppRouter {
  private current: { destroy(): void } | null = null;
  constructor(private renderer: CliRenderer, private harnesses: LoadedHarness[]) {}

  async init() { await this.showHarnessSelect(); }

  async showHarnessSelect() {
    this.current?.destroy();
    const { HarnessSelectScreen } = await import("./screens/harness-select.js");
    const s = new HarnessSelectScreen(this.renderer, this.renderer, this.harnesses,
      (h, id) => this.showChat(h, id));
    this.renderer.root.add(s.root);
    this.current = s;
  }

  async showChat(harness: LoadedHarness, sessionId: string) {
    this.current?.destroy();
    const { ChatScreen } = await import("./screens/chat.js");
    const s = new ChatScreen(this.renderer, this.renderer, harness, sessionId,
      () => this.showHarnessSelect());
    this.renderer.root.add(s.root);
    this.current = s;
  }
}
