# Product Notes

Decisions and the reasoning behind them. Chronological-ish.

## Habit = (name, frequency, createdAt)

Kept the habit shape tiny on purpose. Anything richer (categories, colors, icons) is icebox until real usage says otherwise.

## Streaks are computed, not stored

Compute the streak from the check-ins on demand. Cheaper than maintaining a denormalized field that can drift. Check-ins are the source of truth.

## Weekly reflection

Sundays at 5pm local time, the app prompts "what went well this week?" — drops into a per-week reflection note. No notification spam; it's a prompt you see when you open the app.

## UI principles

- One-tap check-in from the list. No modal. Tap = done, tap again = undo.
- Never block on animation. 60fps or cut the animation.
- Empty state has a concrete first habit suggestion ("drink water"), not "add your first habit".
