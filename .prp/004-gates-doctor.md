```json
{
  "id": "gates-doctor-command",
  "issue_number": 4,
  "issue_title": "Add gates doctor command",
  "complexity": "low",
  "context": {
    "summary": "No read-only diagnostic exists to verify gates setup health — users must manually inspect .gates/config.yaml and .metadata/summary.yaml files or rely on commit-time gate failures",
    "relevant_dirs": ["src/config", "src/gates", "src/context"],
    "files": [
      "src/config/GatesConfig.ts",
      "src/gates/Metadata.ts",
      "src/context/ProjectContext.ts",
      "src/commands/stats.ts"
    ],
    "related_issues": [],
    "out_of_scope": ["src/auth", "src/chat", "src/machine", "src/agent", "src/services/LLM.ts", "src/services/Tools.ts"]
  },
  "spec": {
    "root_cause": "gates lacks a read-only diagnostic command — the checkSummary/ensureStub logic in Metadata.ts only runs at commit time as a blocking gate, not as a proactive health check",
    "changes": [
      {
        "file": "src/commands/stats.ts",
        "description": "Add runDoctor function alongside runStats — reads .gates/config.yaml via loadGatesConfig, counts indexed_directories[], for each directory checks .metadata/summary.yaml exists and status==filled, checks .gates/context.yaml exists via CONTEXT_FILE from ProjectContext.ts, prints structured health report with --json flag support"
      }
    ],
    "constraints": [
      "command entry point: gates doctor (follows stats.ts pattern with shebang and --json flag)",
      "loadGatesConfig is already cached — no new config-loading needed",
      "checkSummary and ensureStub logic ported as read-only (no file creation on missing stub)",
      "CONTEXT_FILE path imported from ProjectContext.ts",
      "structured output: --json flag prints machine-readable report",
      "non-blocking: only reports issues, never throws or blocks"
    ]
  },
  "acceptance": [
    "bun run typecheck exits 0",
    "gates doctor --json outputs valid JSON with config_exists, indexed_count, indexed_dirs[], context_exists, and per-dir health fields",
    "gates doctor prints human-readable health report without --json",
    "gates doctor exits 0 even when issues are found (diagnostic only)",
    "gates doctor detects missing .gates/config.yaml gracefully",
    "gates doctor detects indexed dirs missing .metadata/summary.yaml",
    "gates doctor detects .metadata/summary.yaml with status!=filled"
  ]
}
```