/** Collapse all whitespace runs (including newlines) into single spaces —
 *  the standard projection of multi-line text into a one-line UI slot. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** One-line projection capped at `max` characters, ellipsized. */
export function truncateOneLine(text: string, max: number): string {
  const line = oneLine(text);
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
