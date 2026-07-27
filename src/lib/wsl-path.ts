/**
 * Translate a Windows path into its WSL (Linux) equivalent.
 *
 * This is the single chokepoint for path translation at the picker boundary:
 * main-process dialog handlers translate native dialog results through this
 * function before returning them to the renderer, so the renderer and the WSL
 * daemon only ever see Linux paths. Do not add consumer-side fallbacks.
 *
 * Accepted inputs (forward, back, or mixed slashes; spaces and special
 * characters are preserved verbatim — no escaping or encoding):
 * - Drive-absolute Windows paths: `C:\Users\Me` → `/mnt/c/Users/Me` (drive
 *   letter lowercased). Bare drive roots map to the mount root: `C:\` or
 *   `C:` → `/mnt/c`.
 * - WSL UNC paths: `\\wsl$\<distro>\home\me` and
 *   `\\wsl.localhost\<distro>\home\me` (host token case-insensitive) map to
 *   the in-distro native path `/home/me`; bare `\\wsl$\<distro>` → `/`.
 * - Already-POSIX absolute paths (`/home/me`): returned unchanged, modulo
 *   normalization.
 *
 * Normalization: runs of consecutive separators collapse to one, and a
 * trailing slash is stripped (the root `/` stays `/`).
 *
 * Returns `null` for everything else: relative paths (`foo\bar`, `.`),
 * drive-relative paths (`C:foo`), drive-rooted relative paths (`\Users`),
 * non-WSL UNC shares (`\\server\share`), and the empty string.
 */
export function winToWslPath(p: string): string | null {
  if (p.length === 0) {
    return null;
  }

  const s = p.replaceAll('\\', '/');

  // UNC paths: only \\wsl$\<distro>\... and \\wsl.localhost\<distro>\... are
  // translatable (to the in-distro native path); other shares are rejected.
  if (s.startsWith('//')) {
    const [host, distro, ...rest] = s.split('/').filter((seg) => seg.length > 0);
    if (host === undefined || distro === undefined || !/^(wsl\$|wsl\.localhost)$/i.test(host)) {
      return null;
    }
    return `/${rest.join('/')}`;
  }

  // Drive-absolute paths: C:\... or C:/... (drive-relative C:foo is rejected).
  const driveMatch = /^([A-Za-z]):(.*)$/.exec(s);
  if (driveMatch) {
    const [, drive, rest] = driveMatch;
    if (drive === undefined || rest === undefined || (rest !== '' && !rest.startsWith('/'))) {
      return null;
    }
    const segments = rest.split('/').filter((seg) => seg.length > 0);
    const suffix = segments.length > 0 ? `/${segments.join('/')}` : '';
    return `/mnt/${drive.toLowerCase()}${suffix}`;
  }

  // Already-POSIX absolute paths pass through (checked against the original
  // string so a drive-rooted Windows path like `\Users` is not mistaken for
  // one).
  if (p.startsWith('/')) {
    const segments = s.split('/').filter((seg) => seg.length > 0);
    return `/${segments.join('/')}`;
  }

  return null;
}
