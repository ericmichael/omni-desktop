import type { CheckIn } from './types';

/** Days between two YYYY-MM-DD strings, treating them as local midnights. */
function daysBetween(a: string, b: string): number {
  const d1 = new Date(`${a}T00:00:00`).getTime();
  const d2 = new Date(`${b}T00:00:00`).getTime();
  return Math.round((d2 - d1) / 86_400_000);
}

/**
 * Current streak: the longest run of consecutive daily check-ins ending today
 * or yesterday. Ending "today or yesterday" means missing today doesn't break
 * the streak until tomorrow — a forgiving default.
 */
export function currentStreak(checkIns: CheckIn[], today: string): number {
  const dates = [...new Set(checkIns.map((c) => c.date))].sort().reverse();
  if (dates.length === 0) return 0;

  const gapToFirst = daysBetween(dates[0]!, today);
  if (gapToFirst > 1) return 0;

  let streak = 1;
  for (let i = 1; i < dates.length; i++) {
    if (daysBetween(dates[i]!, dates[i - 1]!) === 1) streak += 1;
    else break;
  }
  return streak;
}
