import type { Project, ProjectSource } from '@/shared/types';

const trimTrailingSlashes = (value: string): string => value.replace(/[\\/]+$/, '');

export function normalizeLocalSourcePath(workspaceDir: string): string {
  const normalized = trimTrailingSlashes(workspaceDir.trim().replace(/\\+/g, '/'));
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function normalizeGitRemoteUrl(repoUrl: string): string {
  const trimmed = trimTrailingSlashes(repoUrl.trim()).replace(/\.git$/i, '');
  const scpLike = trimmed.match(/^([^@\s]+)@([^:\s]+):(.+)$/);
  const parseTarget = scpLike ? `ssh://${scpLike[1]}@${scpLike[2]}/${scpLike[3]}` : trimmed;

  try {
    const parsed = new URL(parseTarget);
    const host = parsed.hostname.toLowerCase();
    const pathname = trimTrailingSlashes(decodeURIComponent(parsed.pathname)).replace(/^\/+/, '').replace(/\.git$/i, '');
    return `${host}/${pathname.toLowerCase()}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

export function sourceIdentityKey(source: ProjectSource): string {
  if (source.kind === 'local') {
    return `local:${normalizeLocalSourcePath(source.workspaceDir)}`;
  }
  return `git-remote:${normalizeGitRemoteUrl(source.repoUrl)}`;
}

export function duplicateSourceIdentityMessage(source: ProjectSource): string {
  return source.kind === 'local'
    ? 'This project already includes that local folder.'
    : 'This project already includes that repository.';
}

export function findDuplicateSourceIdentity(sources: ProjectSource[]): ProjectSource | undefined {
  const seen = new Set<string>();
  for (const source of sources) {
    const key = sourceIdentityKey(source);
    if (seen.has(key)) {
      return source;
    }
    seen.add(key);
  }
  return undefined;
}

export function validateProjectSources(sources: ProjectSource[]): void {
  const seenMountNames = new Set<string>();
  for (const source of sources) {
    if (seenMountNames.has(source.mountName)) {
      throw new Error(`Duplicate mount name: "${source.mountName}". Each source needs a unique name.`);
    }
    seenMountNames.add(source.mountName);
  }

  const duplicate = findDuplicateSourceIdentity(sources);
  if (duplicate) {
    throw new Error(duplicateSourceIdentityMessage(duplicate));
  }
}

/** Extract the local workspace directory from a ProjectSource. Returns undefined for git-remote or undefined source. */
export function getLocalWorkspaceDir(source: ProjectSource | undefined): string | undefined {
  if (source?.kind === 'local') {
    return source.workspaceDir;
  }
  return undefined;
}

/** Assert source is local and return workspaceDir. Throws for git-remote or undefined source. */
export function requireLocalWorkspaceDir(source: ProjectSource | undefined): string {
  if (source?.kind === 'local') {
    return source.workspaceDir;
  }
  throw new Error(`Operation requires a local project source, but got "${source?.kind ?? 'none'}"`);
}

/** Type guard for local sources. */
export function isLocalSource(source: ProjectSource | undefined): source is Extract<ProjectSource, { kind: 'local' }> {
  return source?.kind === 'local';
}

/** Check if a project has at least one linked source. */
export function hasRepo(project: Project): boolean {
  return project.sources.length > 0;
}
