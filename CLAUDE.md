# gates — developer context

Autonomous coding agent harness built on Effect V4 + Anthropic SDK.
The agent loop calls the Claude API directly (no Claude Code dependency).

## What it is

A TypeScript runtime where:
- Every tool call passes through a **gate** before execution
- Every step is persisted to `.gates/runs/<uuid>.jsonl` (audit trail)
- Gates are `Effect.Effect<void, GateError>` — they either pass or fail with a typed error

## Layout

```
src/
├── agent/Loop.ts           agentic tool-use loop (Effect.whileLoop + Ref)
├── gates/
│   ├── Gate.ts             Gate interface + GateError
│   ├── BashSafety.ts       built-in gate: force-push, npm scripts, file ops
│   └── builtin.ts          registers built-in gates via BuiltinGatesLayer
├── machine/
│   └── Persistence.ts      JSONL run persistence (.gates/runs/)
└── services/
    ├── LLM.ts              Anthropic SDK as LLMService (Layer.effect)
    ├── GateRegistry.ts     register/enforce gates
    └── Tools.ts            bash, read, write, edit as ToolHandlers
```

## Effect V4 patterns used here

- Services: `class Foo extends Context.Service<Foo, FooShape>()("gates/Foo") {}`
- Layers: `Layer.effect(Foo)(makeImpl)` — never use `Foo.Default`
- Dependencies declared in return type: `Effect<A, E, LLMService | GateRegistry>`
- Errors: plain classes with `readonly _tag`

## Adding a tool

1. Write a `ToolHandler` in `src/services/Tools.ts`
2. Add to the `handlers` Map
3. Add a `ToolDef` to the `definitions` array
4. Run `bun run typecheck` to verify

## Adding a gate

1. Create `src/gates/<Name>.ts` implementing `Gate` interface
2. Register in `src/gates/builtin.ts` via `registry.register(...)`
3. Run `bun run typecheck` to verify

## Running

```bash
bun run typecheck        # type-check only (no API call)
bun src/index.ts "prompt"  # run the agent
```

Requires `ANTHROPIC_API_KEY` in env.

## Key invariants

- `edit` tool fails if `old_string` not found or appears more than once — always use unique context
- `write` tool overwrites entire files — only use for new files
- Gates run sequentially (concurrency: 1) before every tool call
- Run files are append-only JSONL — never rewrite them
