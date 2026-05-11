import { createCliRenderer, TextRenderable } from "@opentui/core";
import type { LoadedHarness } from "../harness/loader.js";

export async function startTUI(harnesses: LoadedHarness[]): Promise<void> {
  const renderer = await createCliRenderer({ targetFps: 30, useMouse: true, exitOnCtrlC: false });
  renderer.start();
  const t = new TextRenderable(renderer, {
    content: "gates — migrating to OpenTUI...", fg: "#00ffff",
  });
  renderer.root.add(t);
  await new Promise<void>(resolve => {
    renderer.keyInput.on("keypress", (k: { name: string; ctrl: boolean }) => {
      if (k.ctrl && k.name === "c") { renderer.destroy(); resolve(); }
    });
    renderer.on("destroy", resolve);
  });
}
