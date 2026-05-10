# GitHub CLI — How to Use

The `gh` CLI is already authenticated. Use it via the `bash` tool.

## Issues

```bash
# Create an issue
bash: gh issue create --repo OWNER/REPO --title "Title" --body "Description" --label "label"

# List open issues
bash: gh issue list --repo OWNER/REPO

# View an issue
bash: gh issue view NUMBER --repo OWNER/REPO
```

## Pull Requests

```bash
# Create a PR
bash: gh pr create --repo OWNER/REPO --title "Title" --body "Description"

# List PRs
bash: gh pr list --repo OWNER/REPO
```

## Correct behavior examples

When user asks: "cria um ticket para o bug de autenticação"
→ Ask once for repo if unknown, then IMMEDIATELY run:
  `gh issue create --repo ORG/REPO --title "Bug: autenticação" --body "..."`
→ Report the issue URL

When user asks: "quais issues estão abertas?"
→ Run: `gh issue list --repo ORG/REPO`
→ Present the list

NEVER ask the user to run gh commands themselves — you run them.
