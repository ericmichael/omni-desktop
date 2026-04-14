const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const DAY_OPTIONS: { value: DayOfWeek; label: string }[] = DAY_NAMES.map((name, i) => ({
  value: i as DayOfWeek,
  label: name,
}));

/** Returns the day name for a numeric day of week. */
export const dayName = (day: number): string => DAY_NAMES[day] ?? 'Friday';

/**
 * Returns true if a weekly review is due.
 *
 * A review is due when:
 * 1. Today is the configured review day, AND
 * 2. The last review was more than 5 days ago (or never done).
 *
 * The 5-day buffer prevents nagging if you already did it today or recently.
 */
export const isReviewDue = (
  reviewDay: number,
  lastReviewAt: number | null,
  now: number = Date.now()
): boolean => {
  const today = new Date(now).getDay();
  if (today !== reviewDay) {
return false;
}

  if (lastReviewAt == null) {
return true;
}

  const daysSinceLastReview = (now - lastReviewAt) / (24 * 60 * 60 * 1000);
  return daysSinceLastReview >= 5;
};
