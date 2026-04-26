---
name: daily-standup
description: Generate a standup note — tickets moved in the last 24h, what's in progress, and anything blocked.
version: 0.1.0
author: Omni Seed
---

# Daily Standup

Produce a three-section standup note.

## Sections

**Yesterday.** Tickets whose column changed in the last 24h, with from → to columns.

**Today.** Tickets currently in `Implementation` or `Active`, plus anything in `awaiting_input`.

**Blockers.** Tickets with `phase = error` or `blockedBy` non-empty.

## Output

Drop the note into a new Page under the current project titled `Standup YYYY-MM-DD`. Use Page `kind: doc`.

## Rules

- Keep each bullet under 15 words. This is a standup, not a status report.
- If nothing moved in 24h, say so — don't manufacture activity.
- Don't list completed tickets older than 24h.
