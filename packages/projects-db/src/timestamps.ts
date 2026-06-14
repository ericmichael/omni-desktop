/**
 * Convert epoch milliseconds to SQLite-compatible ISO string.
 * Returns format: "YYYY-MM-DD HH:MM:SS.sss" (no timezone suffix).
 */
export function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * "Now" as the space-separated timestamp both backends store and sort on
 * ("YYYY-MM-DD HH:MM:SS.sss", UTC, no `T`/`Z`). Use this when building rows to
 * upsert through {@link IProjectsRepo} so the value sorts lexicographically
 * alongside rows written by SQLite's `datetime('now')` default and Postgres's
 * `to_char(... 'YYYY-MM-DD HH24:MI:SS.MS')`.
 */
export function nowTimestamp(): string {
  return toIso(Date.now());
}

/**
 * Convert a SQLite datetime string back to epoch milliseconds.
 * Accepts both "YYYY-MM-DD HH:MM:SS" and full ISO format.
 */
export function fromIso(iso: string): number {
  // SQLite's datetime() produces "YYYY-MM-DD HH:MM:SS" (no Z).
  // If there's no timezone indicator, treat as UTC.
  const normalized = iso.includes('T') || iso.endsWith('Z') ? iso : `${iso}Z`;
  return new Date(normalized).getTime();
}
