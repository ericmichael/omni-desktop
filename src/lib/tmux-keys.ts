/**
 * tmux-style key tokens → terminal byte sequence.
 *
 * Mirrors `tmux send-keys`: each token is resolved as a key *name* (`C-c`,
 * `Enter`, `Up`, `Escape`, `M-x`, `F5`, …); an unrecognized token is sent
 * literally. `literal` sends every token verbatim (tmux `-l`); `count` repeats
 * the whole resolved sequence (tmux `-N`).
 *
 * Faithful to tmux's semantics: tokens are concatenated with NO inter-key
 * delay. For sequences that need real pacing (e.g. a guaranteed double-SIGINT,
 * where the program must handle the first Ctrl-C before the second arrives),
 * issue `send_keys` twice — same as scripting tmux.
 */

/** Named keys → their terminal byte sequences (xterm / VT100 conventions). */
const NAMED: Record<string, string> = {
  Enter: '\r',
  Return: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Esc: '\x1b',
  Space: ' ',
  BSpace: '\x7f',
  Backspace: '\x7f',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PPage: '\x1b[5~',
  PageDown: '\x1b[6~',
  NPage: '\x1b[6~',
  IC: '\x1b[2~',
  Insert: '\x1b[2~',
  DC: '\x1b[3~',
  Delete: '\x1b[3~',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
};

/** Upper bound on `count` so a stray value can't flood the PTY. */
const MAX_COUNT = 1000;

/** Resolve one tmux-style token to its bytes, or the token itself if literal. */
export function tokenToBytes(token: string): string {
  const named = NAMED[token];
  if (named !== undefined) {
    return named;
  }
  // C-<char>: control. `char & 0x1f` (case-insensitive: C-c == C-C == \x03;
  // C-[ → ESC, C-@ → NUL, etc.).
  if (token.length === 3 && (token[0] === 'C' || token[0] === 'c') && token[1] === '-') {
    return String.fromCharCode(token.charCodeAt(2) & 0x1f);
  }
  // M-<char>: meta/alt → ESC + the (case-sensitive) char.
  if (token.length === 3 && (token[0] === 'M' || token[0] === 'm') && token[1] === '-') {
    return `\x1b${token[2]}`;
  }
  return token; // literal
}

/** Build the byte sequence for a tmux-style key list. */
export function keysToBytes(keys: readonly string[], opts?: { literal?: boolean; count?: number }): string {
  const seq = opts?.literal ? keys.join('') : keys.map(tokenToBytes).join('');
  const count = Math.max(1, Math.min(Math.floor(opts?.count ?? 1), MAX_COUNT));
  return count === 1 ? seq : seq.repeat(count);
}
