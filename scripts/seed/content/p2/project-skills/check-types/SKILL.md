---
name: check-types
description: Run the TypeScript compiler in no-emit mode and summarize the first few errors in plain English, pointing at file:line.
version: 0.1.0
author: Omni Seed
---

# Check Types

Run `npm run typecheck` (which is `tsc --noEmit`) and produce a tight summary.

## Reporting rules

- If there are zero errors, say so in one sentence and stop.
- Otherwise, list the first 5 errors as `file:line — <error message>`. Group by file when there are multiple errors in the same file.
- Note the total error count at the top.
- Don't dump the full tsc output; the user has a terminal if they want that.

## When to stop

- If more than 50 errors, just report the count and suggest rolling back the most recent change rather than triaging.
- If `tsc` itself fails to start (missing binary, bad config), report that — don't pretend there are type errors.
