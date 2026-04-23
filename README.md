# gates

An agentic coding harness built on [Effect V4](https://github.com/Effect-TS/effect) and the Anthropic SDK. Declare workflows as YAML state machines where every state is a hard gate — the agent must produce verifiable evidence before the runner advances.

Inspired by Jesse Vincent's [Rules and Gates](https://blog.fsck.com/2026/04/07/rules-and-gates/) thesis and built on the concepts from [atomic-gates](https://github.com/lucianfialho/atomic-gates).

---

## Architecture

```mermaid
flowchart TB
  classDef input     fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
  classDef gateway   fill:#fef9c3,stroke:#ca8a04,color:#713f12
  classDef gates_cls fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  classDef context   fill:#fce7f3,stroke:#db2777,color:#831843
  classDef knowledge fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef hooks     fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  classDef skill     fill:#f3e8ff,stroke:#9333ea,color:#3b0764
  classDef hitl      fill:#fdf4ff,stroke:#a855f7,color:#581c87

  %% ── INPUT ──────────────────────────────────────────────────────
  subgraph INPUT["  Input  "]
    UP["⊙ User Prompt"]
    SC["⊙ Shortcuts  #42 · solve-issue · write-tests · @chat"]
  end

  %% ── GATEWAY ─────────────────────────────────────────────────────
  subgraph GATEWAY["  Gateway — Intent Router  "]
    IEM{{"classifyIntent()"}}
    QA["CHAT\nQ&A · explain · explore"]
    PATCH["PATCH\nDirect agent prompt"]
    STANDARD["STANDARD\nFull skill lifecycle"]
  end

  UP & SC --> IEM
  IEM -->|question| QA
  IEM -->|quick fix| PATCH
  IEM -->|#N · fix · add · implement| STANDARD

  %% ── GATES ───────────────────────────────────────────────────────
  subgraph GATES["  Gates  "]
    direction TB
    AG["Ambiguity Gatekeeper\nclarify state — blocks unclear requests\nreturns questions if not actionable"]
    BS["BashSafety Gate\nblocks force-push · rm -rf · bad scripts"]
    MG["Metadata Gate\nblocks git commit without .metadata updated"]
    SV["Schema Validator\nblocks state transition without valid JSON"]
  end

  %% ── CONTEXT ──────────────────────────────────────────────────────
  subgraph CONTEXT["  Context  "]
    direction TB
    CM["CLAUDE.md\nProject docs → system prompt"]
    CY[".gates/context.yaml\nAuto file tree + exports + git log"]
    EL["Tool-result Elision\nStale reads → [cached] after 3 turns"]
    FIL["Selective injection\nOnly files from analyze output"]
  end

  %% ── KNOWLEDGE ────────────────────────────────────────────────────
  subgraph KNOWLEDGE["  Knowledge  "]
    direction TB
    META[".metadata/summary.yaml\nPer indexed directory — agent-maintained"]
    CFG[".gates/config.yaml\nDeclares indexed directories"]
    SKILLDIR["skills/ index\nsolve-issue · write-tests · custom"]
    RUNS[".gates/runs/*.jsonl\nAppend-only audit trail per run"]
  end

  %% ── HOOKS ────────────────────────────────────────────────────────
  subgraph HOOKS["  Hooks  "]
    direction TB
    PRE["pre_hook\nBashSafety intercepts every Bash call"]
    GUARD["guard_hook\nMetadata gate intercepts git commit"]
    POST["post_hook\nUpdate context.yaml after run"]
    FAIL["fall_hook\non_error: retry · skip · abort per state"]
  end

  %% ── HITL GATE ────────────────────────────────────────────────────
  subgraph HITL_BOX["  HITL Gate  "]
    HITL["✋ Human Approval\nShows analyze output\nY → proceed · N → abort\nCLI readline or TUI panel"]
  end

  %% ── SKILL LIFECYCLE ──────────────────────────────────────────────
  subgraph LIFECYCLE["  Skill Lifecycle — solve-issue  "]
    direction LR
    S0["clarify\n─────\ngate: ready=true\nor return questions"]
    S1["analyze\n─────\ngate: confirmed\nfile paths + plan\nhitl_pause ✋"]
    S2["branch\n─────\ngate: git checkout\n--show-current ✓"]
    S3["implement\n─────\nBY CONTRACT ═══\ngate: typecheck ✓"]
    S4["verify\n─────\ngate: passed=true\nindependent run"]
    S5["open_pr\n─────\ngate: PR URL\nin output"]
    DONE(["done ✓"])

    S0 -->|ready=true| S1
    S0 -->|ready=false| QOUT(["return questions"])
    S1 --> HITL_GATE{{"HITL ✋"}}
    HITL_GATE -->|approved| S2
    HITL_GATE -->|rejected| ABORT(["aborted"])
    S2 --> S3 --> S4
    S4 -->|passed| S5 --> DONE
    S4 -->|failed| S3
  end

  STANDARD --> LIFECYCLE
  GATES     -.->|enforces| LIFECYCLE
  CONTEXT   -.->|injects into system prompt| LIFECYCLE
  KNOWLEDGE -.->|indexes + audits| LIFECYCLE
  HOOKS     -.->|intercepts tool calls| LIFECYCLE
  HITL_BOX  -.->|pauses between states| LIFECYCLE

  class UP,SC input
  class IEM,QA,PATCH,STANDARD gateway
  class AG,BS,MG,SV gates_cls
  class CM,CY,EL,FIL context
  class META,CFG,SKILLDIR,RUNS knowledge
  class PRE,GUARD,POST,FAIL hooks
  class S0,S1,S2,S3,S4,S5,DONE skill
  class HITL_GATE,HITL hitl
```

---

## The idea

Most coding agents give the model instructions and hope it follows them. That's a rule. Gates is different: each state in a skill has an `output_schema` that the runner validates before advancing. No valid JSON block → retry. Schema mismatch → retry. The model can't rationalize past a gate.

```
analyze  →  gate: confirmed file paths in output
implement →  gate: typecheck_passed: true in output  
verify   →  gate: passed: true in output
done
```

Every run is persisted as JSONL in `.gates/runs/`. Every token spent is tracked. The harness was built dogfooding itself.

---

## Install

```bash
git clone https://github.com/lucianfialho/gates
cd gates
bun install
```

Set your Anthropic API key:

```bash
bun src/index.ts auth set sk-ant-...
# or
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Usage

```bash
# Direct prompt
bun src/index.ts "what files are in src/?"

# Run a skill (state machine)
bun src/index.ts solve-issue "add a --dry-run flag to the CLI"
bun src/index.ts write-tests "src/machine/schema_validate.ts"

# Inspect runs
bun src/index.ts stats          # token spend + cost per run
bun src/index.ts logs           # list last 10 runs
bun src/index.ts logs <runId>   # full event timeline

# Help
bun src/index.ts help
```

---

## Skills

Skills are YAML state machines in `skills/`. Each state has:

- `agent_prompt` — what the agent is asked to do
- `output_schema` — JSON Schema the output must pass (the gate)
- `on_error: retry|skip|abort` — what happens when a gate fails
- `transitions` — where to go next, optionally conditional

**`solve-issue`** — analyze → implement → verify  
Takes an issue description, confirms affected files, implements the change, runs typecheck, verifies independently.

**`write-tests`** — analyze → write → verify  
Takes a file path, reads it, generates tests with full coverage, runs them with `bun test`.

### Writing a skill

```yaml
id: my-skill
version: 1
initial_state: analyze
inputs:
  required:
    - name: issue
      type: string
states:
  analyze:
    agent_prompt: |
      Analyze: {{inputs.issue}}
      GATE CONDITION: confirm file paths exist before responding.
      Respond with a JSON code block: { "files": [...], "plan": [...] }
    output_schema: schemas/analyze.output.schema.json
    on_error: retry
    max_retries: 2
    transitions:
      - to: implement
  implement:
    agent_prompt: |
      Implement. Run typecheck. Only respond when typecheck exits 0.
      Respond with: { "files_changed": [...], "typecheck_passed": true }
    output_schema: schemas/implement.output.schema.json
    transitions:
      - to: done
  done:
    terminal: true
    agent_prompt: ""
```

---

## Tools available to the agent

| Tool | Description |
|---|---|
| `bash` | Run shell commands (optional timeout) |
| `read` | Read a file |
| `read_lines` | Read a specific line range from a file |
| `write` | Write a file |
| `write_lines` | Append lines to a file |
| `edit` | Replace exact string in a file (unique match required) |
| `glob` | List files matching a pattern |
| `grep` | Search files for a pattern |
| `fetch` | HTTP requests |

---

## Token efficiency

Two strategies reduce the cost of multi-turn agent runs:

**Elision** — file-read results older than 3 turns are replaced with `[file cached: path]` before each LLM call. The conversation history stays lean.

**Context snapshot** — after each run, `.gates/context.yaml` is updated with the project's file tree and recent commits. The runner injects only the files relevant to the current task into the system prompt.

---

## Architecture

```
src/
├── agent/Loop.ts          Effect-based agent loop (tool calls, message history)
├── machine/
│   ├── Runner.ts          State machine runner with gate enforcement
│   ├── Skill.ts           YAML skill loader + interpolation + transition resolver
│   ├── Persistence.ts     JSONL append-only run storage
│   └── schema_validate.ts Minimal JSON Schema subset validator
├── services/
│   ├── LLM.ts             Anthropic SDK wrapper (claude-sonnet-4-6)
│   ├── Tools.ts           Tool registry and handlers
│   └── GateRegistry.ts    PreToolUse gate enforcement
├── gates/
│   └── BashSafety.ts      Blocks dangerous bash patterns
├── context/
│   └── ProjectContext.ts  Project snapshot for context injection
└── auth/Auth.ts           BYOK — env var or ~/.local/share/gates/auth.json
```

All layers are Effect V4 services. Dependency injection via `Context.Service` + `Layer`.

---

## References

- [Rules and Gates](https://blog.fsck.com/2026/04/07/rules-and-gates/) — Jesse Vincent's thesis that this harness implements
- [atomic-gates](https://github.com/lucianfialho/atomic-gates) — the Claude Code plugin this project grew out of
- [effect](https://github.com/Effect-TS/effect) — the TypeScript runtime powering the agent loop
- [obra/superpowers](https://github.com/obra/superpowers) — the skill corpus that inspired the YAML skill format

---

## License

MIT
