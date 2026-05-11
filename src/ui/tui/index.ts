import { createCliRenderer } from "@opentui/core";
import type { LoadedHarness } from "../harness/loader.js";
import { AppRouter } from "./router.js";

export async function startTUI(harnesses: LoadedHarness[]): Promise<void> {
  const renderer = await createCliRenderer({
    targetFps: 30,
    useMouse: false,
    exitOnCtrlC: false,
    screenMode: "split-footer",   // scrollback area + fixed footer for input
    footerHeight: 3,
  });
  renderer.start();
  const router = new AppRouter(renderer, harnesses);
  await router.init();
  await new Promise<void>(resolve => {
    renderer.on("destroy", resolve);
  });
}
