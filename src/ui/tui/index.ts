import { createCliRenderer } from "@opentui/core";
import type { LoadedHarness } from "../harness/loader.js";
import { AppRouter } from "./router.js";

export async function startTUI(harnesses: LoadedHarness[]): Promise<void> {
  const renderer = await createCliRenderer({ targetFps: 30, useMouse: true, exitOnCtrlC: false });
  renderer.start();
  const router = new AppRouter(renderer, harnesses);
  await router.init();
  await new Promise<void>(resolve => {
    renderer.on("destroy", resolve);
  });
}
