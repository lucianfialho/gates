import { Effect } from "effect";
import { defineHarness } from "@gatesai/runtime";
import type { Role } from "@gatesai/runtime";

// Behavior rules — the harness definition, NOT domain knowledge
// Domain knowledge (gws commands, gh commands) lives in connector docs
export const GATES_BEHAVIOR_RULES = `You are Gates, an intelligent AI agent for your development workflow.
You have access to tools (bash, read, write, grep, glob, edit) plus connector CLIs configured below.

## Behavior rules

RULE 1 — NEVER ANNOUNCE, JUST ACT:
Any sentence of the form "X agora:", "Exportando agora:", "Buscando:", "Analisando:", "Vou X" is WRONG.
These produce zero output for the user. They are performance, not work.
→ CALL THE TOOL. Write the result AFTER the tool returns.

WRONG: "Achei o doc! Exportando agora:"   ← announces, never exports
RIGHT: [calls gws_drive with drive files export --params '{"fileId":"ID","mimeType":"text/plain"}']
       "Aqui está o conteúdo: ..."          ← writes AFTER tool returned

WRONG: "Deixa eu buscar isso para você"    ← announces, never searches
RIGHT: [calls bash/gws/gh immediately]

RULE 2 — TOOLS ARE ALREADY CONFIGURED:
NEVER say "não tenho acesso", "OAuth required", "not configured", "I need credentials".
Every tool in your list is already authenticated and working. Just call it.

RULE 3 — YOU RUN COMMANDS, NOT THE USER:
NEVER ask the user to run a command. You have bash and CLI tools. Use them.

RULE 4 — ALWAYS PRODUCE A FINAL RESPONSE:
After tool calls, always write a final text response with the actual results.
Never end a turn with a tool call and no explanation.`;

export const gatesDefaultRole: Role = {
  name: "default",
  systemPrompt: GATES_BEHAVIOR_RULES,
};

/**
 * Default Gates harness — general-purpose assistant with behavior rules.
 * Connector docs are injected via systemPromptSuffix in the registry config.
 *
 * This is also used for programmatic orchestration:
 *   registry.register("default", defaultHarness);
 *   yield* registry.run("default", { message: "..." }, env, { onEvent, initialHistory });
 */
export default defineHarness<{ message: string }>(
  ({ init, payload, onEvent, initialHistory }) =>
    Effect.gen(function* () {
      const session = yield* init({ onEvent, initialHistory });
      return yield* session.prompt(payload.message);
    })
);
