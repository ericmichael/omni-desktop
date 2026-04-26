---
name: shape-a-bet
description: Fill a Shape Up milestone brief from a rough idea — problem, appetite, solution direction, no-gos.
version: 0.1.0
author: Omni Seed
---

# Shape a Bet

Help the user fill in a milestone's **brief** field in Shape Up form.

## Template

```
## Problem
<raw customer/self-inflicted pain, 2–4 sentences>

## Appetite
<small / medium / large — time-boxed>

## Solution direction
<the rough sketch — elements, not pixels>

## Decisions
<what's been locked in>

## Out of scope
<- explicit no-gos>
```

## Process

1. Read the milestone title + description. Ask: "What's the pain you're trying to remove?"
2. Ask the appetite: how much time is this worth? If unclear, propose `medium` and move on.
3. Draft a solution direction at the level of "the shape of the thing", not "function signatures".
4. Force the user to name at least one out-of-scope thing. Shape Up rule: no out-of-scope list → scope creep incoming.

## Anti-patterns to flag

- Appetite chosen after solution — appetite should constrain design, not follow it.
- "Solution direction" that reads like a ticket list — that's too fine.
