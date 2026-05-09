// harness.js — plain object export, no imports needed
// When harness-ui is installed, you can use: import { defineHarness } from "harness-ui"

export default {
  name: "Code Assistant",
  description: "Engineering assistant with filesystem access",
  provider: {
    type: "minimax",
    model: "MiniMax-M2.7",
  },
  systemPrompt: `You are a senior software engineer assistant.
You have access to the local filesystem via tools.
Be concise and practical. When asked to analyze code, read the files first.`,
  tools: ["read", "write", "bash", "glob", "grep", "edit"],
  compaction: {
    maxContextTokens: 12000,
    thresholdPercent: 80,
    keepRecentMessages: 6,
  },
};
