# gates

**AI Agent Harness** — CLI and Terminal UI for building AI pipelines.

Built on [effect-gates](https://github.com/lucianfialho/effect-gates) framework.

```bash
npm install -g gates
gates          # opens terminal UI
gates run "explain this codebase"
gates skill meeting-issues
```

## Architecture

```
gates (this repo)            effect-gates (framework)
  src/cli/     ──────────→   @gates-effect/runtime
  src/ui/      ──────────→   @gates-effect/providers
  src/harness/ ──────────→   @gates-effect/skills
                             @gates-effect/sandbox
                             @gates-effect/gates
```

## Status

🚧 **Work in progress** — migrating from effect-gates monorepo.

The harness-ui code is being moved here from `@gates-effect/harness-ui`.
Once published, `gates` will be the single install for the full product.

## Development

```bash
git clone https://github.com/lucianfialho/gates
cd gates
npm install
npm run dev
```

## Related

- [effect-gates](https://github.com/lucianfialho/effect-gates) — the framework library
