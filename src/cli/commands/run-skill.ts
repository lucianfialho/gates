import { Effect } from "effect";
import { loadSkillFromDirectory, createSkillExecutorWithSandbox } from "@gatesai/skills";
import type { DiscoveredSkill, SkillContext } from "@gatesai/skills";
import { makeSandbox } from "@gatesai/sandbox";

interface RunSkillOptions {
  skillPath: string;
  input: Record<string, unknown>;
  sandboxType?: "memory" | "local";
  verbose?: boolean;
  apiKey?: string;
  basePath?: string;
}

const skillCache = new Map<string, DiscoveredSkill>();

const getOrLoadSkill = async (skillPath: string): Promise<DiscoveredSkill> => {
  if (skillCache.has(skillPath)) {
    return skillCache.get(skillPath)!;
  }
  const skill = await Effect.runPromise(loadSkillFromDirectory(skillPath)) as DiscoveredSkill;
  skillCache.set(skillPath, skill);
  return skill;
};

export const runSkill = async (options: RunSkillOptions): Promise<void> => {
  const { skillPath, input, sandboxType = "local", verbose = false, apiKey, basePath = process.cwd() } = options;

  if (verbose) {
    console.log(`Loading skill from: ${skillPath}`);
  }

  const skillResult = await getOrLoadSkill(skillPath);

  if (verbose) {
    console.log(`Skill loaded: ${skillResult.name}`);
    console.log(`Initial state: ${skillResult.config.initialState}`);
    console.log(`States: ${skillResult.config.states.map((s: { id: string }) => s.id).join(", ")}`);
  }

  const sandbox = await Effect.runPromise(makeSandbox(sandboxType));

  if (verbose) {
    console.log(`Sandbox created: ${sandboxType}`);
  }

const delegateSkill = (
    targetSkillName: string,
    inputs: Record<string, string>,
    _context: SkillContext
  ): Effect.Effect<unknown, Error> => {
    const execute = async (): Promise<unknown> => {
      if (verbose) {
        console.log(`Delegating to skill: ${targetSkillName} with inputs:`, inputs);
      }
      const targetPath = `${basePath}/.gates/skills/${targetSkillName}`;
      const targetSkill = await getOrLoadSkill(targetPath);
      const targetSandbox = await Effect.runPromise(makeSandbox(sandboxType));
      const executor = await createSkillExecutorWithSandbox(targetSkill.config, targetSandbox, apiKey);
      const result = await Effect.runPromise(executor.execute(inputs));
      return { delegated: targetSkillName, result };
    };
    return Effect.tryPromise({ try: execute, catch: (e) => new Error(String(e)) });
  };

  const executor = await createSkillExecutorWithSandbox(skillResult.config, sandbox, apiKey, delegateSkill);

  if (verbose) {
    console.log("Executing skill...");
  }

  let context: SkillContext;
  try {
    context = await Effect.runPromise(executor.execute(input));
  } catch (err) {
    const skillErr = err as { code?: string; message?: string };
    console.error(`\nSkill failed [${skillErr.code ?? "UNKNOWN"}]: ${skillErr.message ?? String(err)}`);
    process.exit(1);
  }

  console.log("\n=== Skill Results ===");
  console.log(`Skill: ${context.skillName}`);
  console.log(`Final state: ${context.state}`);
  console.log(`Steps: ${context.results.length}`);
  console.log(`Errors: ${context.errors.length}`);

  if (context.results.length > 0) {
    console.log("\n--- Results ---");
    for (const result of context.results) {
      console.log(`[${result.state}] ${JSON.stringify(result.output).substring(0, 100)}`);
    }
  }

  if (context.errors.length > 0) {
    console.log("\n--- Errors ---");
    for (const error of context.errors) {
      console.log(`[${error.state}] ${error.error}`);
    }
  }

  if (verbose) {
    console.log("\n--- Events ---");
    const events = await Effect.runPromise(executor.getEvents());
    for (const event of events) {
      console.log(`${event.type}: ${event.state ?? ""} ${event.transition ? `-> ${event.transition}` : ""}`);
    }
  }
};

export const parseSkillInput = (inputStr: string): Record<string, unknown> => {
  try {
    return JSON.parse(inputStr);
  } catch {
    const pairs = inputStr.split(",").map((p) => p.split("="));
    const result: Record<string, unknown> = {};
    for (const [key, value] of pairs) {
      if (key && value !== undefined) {
        result[key.trim()] = value.trim();
      }
    }
    return result;
  }
};

export const findSkillPath = (skillName: string, basePath?: string): string => {
  const base = basePath ?? process.cwd();
  return `${base}/.gates/skills/${skillName}`;
};