/**
 * UI entry point — delegates to harness-ui server + TUI.
 * Code migrated from @gates-effect/harness-ui once that package
 * is extracted out of the effect-gates monorepo.
 */

export interface UIOptions {
  dir: string;
  port: string;
  serverOnly: boolean;
}

export async function startUI(options: UIOptions): Promise<void> {
  // Temporary: show migration message until harness-ui code is moved here
  console.log(`gates ui — starting from ${options.dir}`);
  console.log(`Port: ${options.port}`);
  console.log();
  console.log("Harness UI code is being migrated from @gates-effect/harness-ui.");
  console.log("Run: pnpm --filter @gates-effect/harness-ui exec node dist/index.js");
}
