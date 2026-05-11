import {
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
} from "@opentui/core";
import type { CliRenderer, RenderContext } from "@opentui/core";
import type { LoadedHarness } from "../../harness/loader.js";
import { DEFAULT_PORT } from "../../server/index.js";

export class HarnessSelectScreen {
  root: BoxRenderable;
  private renderer: CliRenderer;
  private keyHandler: (key: { name: string; ctrl: boolean }) => void;

  constructor(
    ctx: RenderContext,
    renderer: CliRenderer,
    harnesses: LoadedHarness[],
    onSelect: (harness: LoadedHarness, sessionId: string) => void,
  ) {
    this.renderer = renderer;

    this.root = new BoxRenderable(ctx, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });

    const header = new BoxRenderable(ctx, {
      height: 1,
      border: ["bottom"],
      borderColor: "#00ffff",
    });
    const headerText = new TextRenderable(ctx, {
      content: "◆ gates  Select a harness",
    });
    header.add(headerText);
    this.root.add(header);

    const body = new BoxRenderable(ctx, { flexGrow: 1 });
    const options = harnesses.map((h) => ({
      name: h.name,
      description: (() => {
        const providerType = h.config.provider.type ?? "minimax";
        const model = (h.config.provider as { model?: string }).model;
        return model ? `${providerType}/${model}` : providerType;
      })(),
    }));
    const sel = new SelectRenderable(ctx, { options, flexGrow: 1 });
    sel.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const harness = harnesses[sel.getSelectedIndex()];
      if (!harness) return;
      fetch(`http://localhost:${DEFAULT_PORT}/api/default-session`, {
        method: "POST",
      })
        .then((res) => res.json())
        .then((data) => {
          const { sessionId } = data as { sessionId: string };
          onSelect(harness, sessionId);
        })
        .catch(() => onSelect(harness, ""));
    });
    renderer.focusRenderable(sel);
    body.add(sel);
    this.root.add(body);

    const footer = new BoxRenderable(ctx, { height: 1 });
    const footerText = new TextRenderable(ctx, {
      content: "↑↓ navigate  ↵ select  q quit  esc quit",
    });
    footer.add(footerText);
    this.root.add(footer);

    this.keyHandler = (key: { name: string; ctrl: boolean }) => {
      if (key.name === "q" || key.name === "escape") renderer.destroy();
    };
    renderer.keyInput.on("keypress", this.keyHandler);
  }

  destroy(): void {
    this.renderer.keyInput.off("keypress", this.keyHandler);
    this.root.destroy();
  }
}
