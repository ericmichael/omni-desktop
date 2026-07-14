import type { ProjectSource } from '@/shared/types';

/** Shorten a local path to the last 2 segments (e.g. ~/projects/my-app → projects/my-app). */
export function shortenPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) {
    return fullPath;
  }
  return parts.slice(-2).join('/');
}

/** Shorten a git remote URL to org/repo (e.g. https://github.com/org/repo.git → org/repo). */
export function shortenRepoUrl(url: string): string {
  try {
    const cleaned = url.replace(/\.git$/, '');
    const parsed = new URL(cleaned);
    return parsed.pathname.replace(/^\//, '');
  } catch {
    // Not a valid URL — try extracting from ssh-style (git@host:org/repo.git)
    const sshMatch = url.match(/:([^/].*?)(?:\.git)?$/);
    if (sshMatch) {
      return sshMatch[1]!;
    }
    return url;
  }
}

/** Compact display label for a source row (mount-agnostic). */
export function sourceLabel(source: ProjectSource): string {
  return source.kind === 'local' ? shortenPath(source.workspaceDir) : shortenRepoUrl(source.repoUrl);
}

/** Full location string, for tooltips and detail rows. */
export function sourceLocation(source: ProjectSource): string {
  return source.kind === 'local' ? source.workspaceDir : source.repoUrl;
}
