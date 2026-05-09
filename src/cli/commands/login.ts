import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

interface LoginOptions {
  provider?: string;
  key?: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".gates");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

interface Config {
  providers: Record<string, { apiKey?: string; model?: string }>;
}

const PROVIDER_MODELS: Record<string, { default: string; options: string[] }> = {
  minimax: {
    default: "MiniMax-M2.7",
    options: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.1"],
  },
  anthropic: {
    default: "claude-sonnet-4-5-20250514",
    options: ["claude-sonnet-4-5-20250514", "claude-opus-4-5-20250514", "claude-3-5-sonnet-20241022"],
  },
  openai: {
    default: "gpt-4o",
    options: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
  },
  github: {
    default: "gpt-4o",
    options: ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet"],
  },
};

const readConfig = (): Config => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { providers: {} };
  }
};

const writeConfig = (config: Config): void => {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
};

const promptApiKey = (provider: string): Promise<string> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`Enter your ${provider} API key: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

export const login = async (options: LoginOptions): Promise<void> => {
  const provider = options.provider ?? "minimax";
  const modelInfo = PROVIDER_MODELS[provider] ?? { default: "gpt-4o", options: ["gpt-4o"] };

  let apiKey = options.key ?? process.env[`${provider.toUpperCase()}_API_KEY`];

  if (!apiKey) {
    console.log(`\nConnecting to ${provider}...`);
    apiKey = await promptApiKey(provider);
  }

  if (!apiKey) {
    console.error("No API key provided. Run 'gates login --help' for usage.");
    process.exit(1);
  }

  console.log("\n╭─────────────────────────────────────────────────────────────╮");
  console.log("│                     Select Model                          │");
  console.log("╰─────────────────────────────────────────────────────────────╯\n");

  modelInfo.options.forEach((m, i) => {
    const marker = m === modelInfo.default ? " (default)" : "";
    console.log(`  ${i + 1}. ${m}${marker}`);
  });
  console.log("\n  0. Cancel (use default)\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const modelAnswer = await new Promise<string>((resolve) => rl.question("Enter choice: ", resolve));
  rl.close();

  let selectedModel = modelInfo.default;
  if (modelAnswer !== "0" && modelAnswer !== "") {
    const modelIdx = parseInt(modelAnswer, 10) - 1;
    if (modelIdx >= 0 && modelIdx < modelInfo.options.length) {
      selectedModel = modelInfo.options[modelIdx];
    }
  }

  const config = readConfig();

  if (!config.providers[provider]) {
    config.providers[provider] = {};
  }
  config.providers[provider].apiKey = apiKey;
  config.providers[provider].model = selectedModel;

  writeConfig(config);

  console.log(`\n✓ Logged in to ${provider}!`);
  console.log(`  Model: ${selectedModel}`);
  console.log(`  API key saved to ~/.gates/config.json`);
};

export const connect = async (): Promise<void> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const providers = ["minimax", "anthropic", "openai", "github"];

  console.log("\n╭─────────────────────────────────────────────────────────────╮");
  console.log("│                     Gates Connect                          │");
  console.log("╰─────────────────────────────────────────────────────────────╯");
  console.log("\nSelect a provider:\n");

  providers.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p}`);
  });
  console.log("\n  0. Cancel\n");

  const question = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

  const answer = await question("Enter choice (1-4): ");

  if (answer === "0" || answer === "") {
    console.log("Cancelled.");
    rl.close();
    return;
  }

  const idx = parseInt(answer, 10) - 1;
  if (idx < 0 || idx >= providers.length) {
    console.error("Invalid selection.");
    rl.close();
    return;
  }

  const provider = providers[idx];

  console.log(`\nEnter your ${provider} API key:`);
  const apiKey = await question("> ");

  if (!apiKey) {
    console.error("No API key provided.");
    rl.close();
    return;
  }

  const modelInfo = PROVIDER_MODELS[provider] ?? { default: "gpt-4o", options: ["gpt-4o"] };

  console.log("\n╭─────────────────────────────────────────────────────────────╮");
  console.log("│                     Select Model                          │");
  console.log("╰─────────────────────────────────────────────────────────────╯\n");

  modelInfo.options.forEach((m, i) => {
    const marker = m === modelInfo.default ? " (default)" : "";
    console.log(`  ${i + 1}. ${m}${marker}`);
  });
  console.log("\n  0. Cancel (use default)\n");

  const modelAnswer = await question("Enter choice: ");

  let selectedModel = modelInfo.default;

  if (modelAnswer !== "0" && modelAnswer !== "") {
    const modelIdx = parseInt(modelAnswer, 10) - 1;
    if (modelIdx >= 0 && modelIdx < modelInfo.options.length) {
      selectedModel = modelInfo.options[modelIdx];
    }
  }

  const config = readConfig();

  if (!config.providers[provider]) {
    config.providers[provider] = {};
  }
  config.providers[provider].apiKey = apiKey;
  config.providers[provider].model = selectedModel;

  writeConfig(config);

  console.log(`\n✓ Connected to ${provider}!`);
  console.log(`  Model: ${selectedModel}`);
  console.log(`  API key saved to ~/.gates/config.json`);

  rl.close();
};