---
name: write-commit-message
description: Draft a concise conventional-commit-style message from the staged diff. Focuses on the "why" over the "what".
version: 0.1.0
author: Omni Seed
---

# Write Commit Message

Run `git diff --staged` (and `git diff` for unstaged context if nothing is staged). Then draft a commit message following these rules:

## Format

```
<type>(<scope>): <subject, imperative, under 70 chars>

<optional body — explain WHY this change, not what>
```

## Types

- `feat` — new user-visible feature
- `fix` — bug fix
- `refactor` — internal restructure, no behavior change
- `test` — add/update tests only
- `docs` — README / comments / CLAUDE.md
- `chore` — build, deps, config

## Rules

- Subject in imperative: "add", "fix", "update" — not "added" / "adds".
- No trailing period on the subject.
- If the change is obvious from the diff (renamed a variable), skip the body.
- If the change has a non-obvious reason (workaround for a bug, perf concern), the body is where you explain it.
- If this project is not a git repo, say so and stop.
