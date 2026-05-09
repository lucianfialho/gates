import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type ProviderType = "minimax" | "anthropic" | "openai";

export interface ProviderConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

const CONFIG_FILE = path.join(os.homedir(), ".gates", "config.json");

interface Config {
  providers: Record<string, { apiKey?: string; model?: string }>;
}

const readConfig = (): Config => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { providers: {} };
  }
};

export const getProviderConfig = (provider: ProviderType): { apiKey: string | null; model: string | undefined } => {
  const envVar = `${provider.toUpperCase()}_API_KEY`;
  const envKey = process.env[envVar];
  const config = readConfig();
  const providerConfig = config.providers[provider];

  return {
    apiKey: envKey ?? providerConfig?.apiKey ?? null,
    model: providerConfig?.model,
  };
};

export const getApiKey = (provider: ProviderType): string | null => {
  return getProviderConfig(provider).apiKey;
};

export const requireApiKey = (provider: ProviderType): Effect.Effect<string, { message: string }> => {
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    return Effect.fail({
      message: `Missing ${provider.toUpperCase()}_API_KEY. Run 'gates login ${provider}' first.`,
    });
  }
  return Effect.succeed(apiKey);
};