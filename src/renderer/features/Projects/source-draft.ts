/**
 * Pure helpers for the source-add flow: a flat `SourceDraft` editing shape and
 * its conversion to `ProjectSource[]`. No React — shared by `AddSourceDialog`.
 *
 * Drafts carry the original `ProjectSource.id` when editing (so per-source
 * ticket PR state stays attached); fresh drafts get a new id at convert time.
 */
import { validateProjectSources } from '@/shared/project-source';
import type { ProjectSource } from '@/shared/types';

export type SourceDraft = {
  /** Local-only stable key. Stays the same across edits of the same row. */
  uid: string;
  /** `null` when the row is new; a `ProjectSource.id` to preserve when editing. */
  id: string | null;
  kind: 'local' | 'git-remote';
  mountName: string;
  workspaceDir: string;
  repoUrl: string;
  defaultBranch: string;
};

/** Auto-derive a mountName slug from a path or repo URL. */
export const deriveMountName = (s: SourceDraft): string => {
  const raw =
    s.kind === 'local'
      ? (s.workspaceDir.replace(/\/+$/, '').split('/').pop() ?? '')
      : (s.repoUrl
          .replace(/\.git$/, '')
          .replace(/\/+$/, '')
          .split(/[/:]/)
          .pop() ?? '');
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '');
};

let _uidSeq = 0;
const nextUid = (): string => `src-draft-${++_uidSeq}-${Math.random().toString(36).slice(2, 8)}`;
const newSourceId = (): string => Math.random().toString(36).slice(2, 18);

/** Construct a fresh empty local-source draft. */
export function emptyLocalDraft(): SourceDraft {
  return { uid: nextUid(), id: null, kind: 'local', mountName: '', workspaceDir: '', repoUrl: '', defaultBranch: '' };
}

/**
 * Validate + convert drafts to ProjectSource[]. Returns either the sources
 * (dropping drafts with empty path/URL — still-being-typed rows) or an error
 * string the caller surfaces.
 */
export function draftsToSources(
  drafts: SourceDraft[]
): { ok: true; sources: ProjectSource[] } | { ok: false; error: string } {
  const sources: ProjectSource[] = [];
  const seenMountNames = new Set<string>();
  for (const d of drafts) {
    const path = d.kind === 'local' ? d.workspaceDir.trim() : d.repoUrl.trim();
    if (!path) {
      continue; // empty rows are dropped silently
    }
    const mountName = (d.mountName.trim() || deriveMountName(d) || 'source').trim();
    if (seenMountNames.has(mountName)) {
      return { ok: false, error: `Duplicate mount name: "${mountName}". Each source needs a unique name.` };
    }
    seenMountNames.add(mountName);
    const baseFields = { id: d.id ?? newSourceId(), mountName };
    if (d.kind === 'local') {
      sources.push({ ...baseFields, kind: 'local', workspaceDir: path });
    } else {
      const branch = d.defaultBranch.trim();
      sources.push({ ...baseFields, kind: 'git-remote', repoUrl: path, ...(branch ? { defaultBranch: branch } : {}) });
    }
  }
  try {
    validateProjectSources(sources);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid project sources.' };
  }
  return { ok: true, sources };
}
