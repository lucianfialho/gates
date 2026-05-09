export interface HarnessRole {
  readonly name: string;
  readonly systemPrompt: string;
  readonly model?: string;
}

export interface HarnessProvider {
  readonly type: "anthropic" | "minimax" | "openai";
  readonly model?: string;
  readonly apiKey?: string;
}

export interface HarnessConfig {
  readonly name: string;
  readonly description?: string;
  readonly provider: HarnessProvider;
  readonly roles?: HarnessRole[];
  readonly defaultRole?: string;
  readonly skills?: string[];
  readonly tools?: Array<"read" | "write" | "bash" | "glob" | "grep" | "edit">;
  readonly systemPrompt?: string;
  readonly compaction?: {
    readonly maxContextTokens?: number;
    readonly thresholdPercent?: number;
    readonly keepRecentMessages?: number;
  };
}

export const defineHarness = (config: HarnessConfig): HarnessConfig => config;
