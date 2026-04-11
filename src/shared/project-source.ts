import type { ProjectSource } from '@/shared/types';

/** Extract the local workspace directory from a ProjectSource. Returns undefined for git-remote. */
export function getLocalWorkspaceDir(source: ProjectSource): string | undefined {
  if (source.kind === 'local') return source.workspaceDir;
  return undefined;
}

/** Assert source is local and return workspaceDir. Throws for git-remote. */
export function requireLocalWorkspaceDir(source: ProjectSource): string {
  if (source.kind === 'local') return source.workspaceDir;
  throw new Error(`Operation requires a local project source, but got "${source.kind}"`);
}

/** Type guard for local sources. */
export function isLocalSource(source: ProjectSource): source is { kind: 'local'; workspaceDir: string; gitDetected?: boolean } {
  return source.kind === 'local';
}
