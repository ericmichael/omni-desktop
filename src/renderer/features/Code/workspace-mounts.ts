import type { WorkspaceMountDescriptor } from '@/shared/types';

/**
 * The scope the workspace sidecar surfaces (Files/Git/Review) root
 * themselves at, derived from the environment's authoritative mount table.
 *
 * A single-mount environment carries one redundant wrapper level whenever
 * the mount landed under the root (container `/workspace/<mountName>`
 * layouts — a chat scratch session's wrapper is literally the session id):
 * scope to the mount. A mount that IS the root (`path === '.'`, the
 * single-local-source host layout) and multi-mount environments need no
 * scoping — with several mounts, the mount level is real information.
 */
export function workspaceScopeFromMounts(mounts: WorkspaceMountDescriptor[] | undefined): string | undefined {
  if (!mounts || mounts.length !== 1) {
    return undefined;
  }
  const path = mounts[0]?.path;
  return path && path !== '.' ? path : undefined;
}
