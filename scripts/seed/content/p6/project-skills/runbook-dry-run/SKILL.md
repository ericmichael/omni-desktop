---
name: runbook-dry-run
description: Walk through a runbook step-by-step with the user — read each step, confirm the prerequisite before moving on, and stop at any destructive action for explicit approval.
version: 0.1.0
author: Omni Seed
---

# Runbook Dry Run

Help the user rehearse a runbook without actually firing any destructive commands.

## Process

1. Ask the user which runbook (by filename under `runbooks/`).
2. Read the runbook markdown.
3. For each numbered step:
   - Read the step aloud (in text).
   - State what it expects to find (e.g., "the primary is down").
   - Ask: "confirm ready to simulate, or skip?"
4. At any step containing a destructive command (one that starts with `./scripts/`), do NOT execute. Instead, echo the command and describe what it would do.

## Scope

Specific to `platform-oncall-runbooks`. Knows:
- Runbooks live in `runbooks/*.md`.
- Scripts that mutate state live in `scripts/`.
- The convention is that any runbook that calls a `scripts/` command is destructive.

## Anti-patterns

- Never run a `./scripts/` command during a dry-run. The whole point is rehearsal.
- Never skip steps to "save time" — the point of the dry-run is noticing which steps are unclear.
