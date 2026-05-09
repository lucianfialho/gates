import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type { HarnessConfig } from "./define.js";

export interface LoadedHarness {
  readonly name: string;
  readonly dirPath: string;
  readonly config: HarnessConfig;
}

const HARNESS_DIRS = [
  ".gates/harnesses",
];

const DEFAULT_HARNESS: HarnessConfig = {
  name: "Assistant",
  description: "General-purpose assistant",
  provider: { type: "minimax" },
  tools: ["read", "write", "bash", "glob", "grep", "edit"],
  systemPrompt: "You are a helpful assistant with access to the local filesystem.",
};

export async function discoverHarnesses(basePath: string = process.cwd()): Promise<LoadedHarness[]> {
  const harnesses: LoadedHarness[] = [];

  for (const harnessDir of HARNESS_DIRS) {
    const fullDir = path.join(basePath, harnessDir);
    if (!fs.existsSync(fullDir)) continue;

    const entries = fs.readdirSync(fullDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(fullDir, entry.name);
      const configFile = findConfigFile(dirPath);
      if (!configFile) continue;

      try {
        const mod = await import(pathToFileURL(configFile).href);
        const config: HarnessConfig = mod.default ?? mod;
        harnesses.push({ name: config.name ?? entry.name, dirPath, config });
      } catch (e) {
        console.warn(`[harness-ui] Failed to load ${configFile}: ${e}`);
      }
    }
  }

  if (harnesses.length === 0) {
    harnesses.push({
      name: DEFAULT_HARNESS.name,
      dirPath: basePath,
      config: DEFAULT_HARNESS,
    });
  }

  return harnesses;
}

function findConfigFile(dir: string): string | null {
  for (const name of ["harness.js", "harness.mjs", "harness.ts"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
