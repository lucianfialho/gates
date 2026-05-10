import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type { HarnessConfig } from "./define.js";
import type { FunctionalHarnessDef } from "./define.js";

// ── LoadedHarness ─────────────────────────────────────────────────────────────

export interface LoadedHarness {
  readonly name: string;
  readonly dirPath: string;
  /** Always present — synthesized from functional harness metadata if needed */
  readonly config: HarnessConfig;
  /** Present when harness file exports a defineHarness(fn) functional harness */
  readonly def?: FunctionalHarnessDef;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const HARNESS_DIRS = [".gates/harnesses"];

const DEFAULT_HARNESS: HarnessConfig = {
  name: "Assistant",
  description: "General-purpose assistant",
  provider: { type: "minimax" },
  tools: ["read", "write", "bash", "glob", "grep", "edit"],
  systemPrompt: "You are a helpful assistant with access to the local filesystem.",
};

// ── Discovery ─────────────────────────────────────────────────────────────────

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
        const mod = await import(pathToFileURL(configFile).href) as Record<string, unknown>;
        const loaded = loadFromModule(mod, entry.name, dirPath);
        if (loaded) harnesses.push(loaded);
      } catch (e) {
        console.warn(`[loader] Failed to load ${configFile}: ${e}`);
      }
    }
  }

  if (harnesses.length === 0) {
    harnesses.push({ name: DEFAULT_HARNESS.name!, dirPath: basePath, config: DEFAULT_HARNESS });
  }

  return harnesses;
}

// ── Module interpreter ────────────────────────────────────────────────────────

function loadFromModule(
  mod: Record<string, unknown>,
  dirName: string,
  dirPath: string,
): LoadedHarness | null {
  const exported = mod["default"] ?? mod;

  // ── Functional harness: defineHarness(fn) ────────────────────────────────
  if (
    exported !== null &&
    typeof exported === "object" &&
    (exported as Record<string, unknown>)["_tag"] === "functional"
  ) {
    const def = exported as FunctionalHarnessDef;
    const name = (mod["name"] as string | undefined) ?? dirName;
    const description = (mod["description"] as string | undefined) ?? "";
    const provider = (mod["provider"] as HarnessConfig["provider"] | undefined)
      ?? { type: "anthropic" as const };

    return {
      name,
      dirPath,
      def,
      config: { name, description, provider, tools: [] },
    };
  }

  // ── YAML-style config harness ─────────────────────────────────────────────
  const config = exported as HarnessConfig;
  if (config && typeof config === "object" && config.provider) {
    return {
      name: config.name ?? dirName,
      dirPath,
      config,
    };
  }

  console.warn(`[loader] ${dirPath}: default export is neither a FunctionalHarnessDef nor a HarnessConfig`);
  return null;
}

function findConfigFile(dir: string): string | null {
  for (const name of ["harness.js", "harness.mjs", "harness.ts"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
