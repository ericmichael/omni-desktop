import type { Project, ProjectSource } from '@/shared/types';

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
export function isLocalSource(source: ProjectSource | undefined): source is { kind: 'local'; workspaceDir: string; gitDetected?: boolean } {
  return source?.kind === 'local';
}

/** Check if a project has a linked repo. */
export function hasRepo(project: Project): boolean {
  return project.source != null;
}
