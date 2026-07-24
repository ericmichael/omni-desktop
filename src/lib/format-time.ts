/**
 * Compact timestamp for UI lists: time only for today ("9:04 AM"),
 * month + day otherwise ("Jul 12, 9:04 AM"), year added when it differs.
 */
export function formatTimestamp(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const ref = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === ref.toDateString()) {
    return time;
  }
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === ref.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

/** Time of day only ("9:04 AM") — for feeds whose date context comes from
 *  day dividers. */
export function formatTimeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Day-divider label: "Today", "Yesterday", else "Fri, Jul 12" (year added
 *  when it differs). */
export function formatDayLabel(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const ref = new Date(now);
  if (d.toDateString() === ref.toDateString()) {
    return 'Today';
  }
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === ref.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Compact duration: "42s", "3m", "1h 5m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return '<1s';
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}
