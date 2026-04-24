export const USAGE = `
gates — autonomous coding agent

USAGE
  gates [--verbose] <prompt>                        run the agent with a direct prompt
  gates [--verbose] <skill> "<description>"         run a skill
  gates [--verbose] run <skill.yaml> [key=value .]  run a skill by path
  gates chat                                        interactive TUI
  gates simulate <skill.yaml> [key=value .]         trace skill flow without LLM calls
  gates stats                                       token usage and cost per run
  gates stats --json                                JSON output
  gates logs                                        list last 10 runs
  gates logs <runId>                                full event timeline for a run
  gates clean                                       remove old runs, keep last 20
  gates clean --keep <n>                            keep last n runs (0 = remove all)
  gates resume <run-id>                             resume a failed skill run
  gates auth set <key>                              save API key
  gates auth show                                   show stored key (masked)
  gates auth remove                                 delete stored key
  gates version                                    show version
  gates help                                        show this message
`.trim()