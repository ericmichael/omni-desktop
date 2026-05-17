/**
 * Multi-source list editor for a Project. Renders one card per source
 * with kind dropdown, path/URL input (Browse button for local), mount
 * name input, and a Remove button. An "Add source" button below.
 *
 * State shape used by callers is ``SourceDraft[]`` — a flat editing
 * form that's converted to ``ProjectSource[]`` at submit time via
 * :func:`draftsToSources`. Drafts preserve the original
 * ``ProjectSource.id`` on existing sources so per-source ticket PR
 * state stays attached across edits; new sources get a fresh id.
 */
import { makeStyles, shorthands, tokens } from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import { memo, useCallback, useState } from 'react';

import { Button, Input, Select } from '@/renderer/ds';
import { DirectoryBrowserDialog } from '@/renderer/features/Tickets/DirectoryBrowserDialog';
import type { ProjectSource } from '@/shared/types';

export type SourceDraft = {
  /** Local-only stable React key. Stays the same across edits of the same row. */
  uid: string;
  /** ``null`` when the row is new; a ``ProjectSource.id`` to preserve when editing. */
  id: string | null;
  kind: 'local' | 'git-remote';
  mountName: string;
  workspaceDir: string;
  repoUrl: string;
  defaultBranch: string;
};

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  cardTitle: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  field: { display: 'flex', flexDirection: 'column', gap: '4px' },
  label: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  row: { display: 'flex', gap: tokens.spacingHorizontalS },
  full: { width: '100%' },
  dirRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  dirDisplay: {
    flex: '1 1 0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    borderRadius: tokens.borderRadiusMedium,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground1,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
  },
  addBtn: { alignSelf: 'flex-start' },
  hint: { fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 },
});

/** Auto-derive a mountName slug from a path or repo URL. */
const deriveMountName = (s: SourceDraft): string => {
  const raw =
    s.kind === 'local'
      ? s.workspaceDir.replace(/\/+$/, '').split('/').pop() ?? ''
      : s.repoUrl
          .replace(/\.git$/, '')
          .replace(/\/+$/, '')
          .split(/[/:]/)
          .pop() ?? '';
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
};

let _uidSeq = 0;
const nextUid = (): string => `src-draft-${++_uidSeq}-${Math.random().toString(36).slice(2, 8)}`;

/** Build a draft list from an existing project's sources (or an empty default). */
export function sourcesToDrafts(sources: ProjectSource[]): SourceDraft[] {
  if (sources.length === 0) return [];
  return sources.map((s) => ({
    uid: nextUid(),
    id: s.id,
    kind: s.kind,
    mountName: s.mountName,
    workspaceDir: s.kind === 'local' ? s.workspaceDir : '',
    repoUrl: s.kind === 'git-remote' ? s.repoUrl : '',
    defaultBranch: s.kind === 'git-remote' ? (s.defaultBranch ?? '') : '',
  }));
}

/** Construct a fresh empty local-source draft row. */
export function emptyLocalDraft(): SourceDraft {
  return {
    uid: nextUid(),
    id: null,
    kind: 'local',
    mountName: '',
    workspaceDir: '',
    repoUrl: '',
    defaultBranch: '',
  };
}

/**
 * Validate + convert drafts to ProjectSource[]. Returns either an array
 * of sources (drops drafts with empty path/URL — these are still-being-
 * typed rows the user hasn't filled in) or an error string the caller
 * surfaces to the user.
 */
export function draftsToSources(drafts: SourceDraft[]): { ok: true; sources: ProjectSource[] } | { ok: false; error: string } {
  const sources: ProjectSource[] = [];
  const seenMountNames = new Set<string>();
  for (const d of drafts) {
    const path = d.kind === 'local' ? d.workspaceDir.trim() : d.repoUrl.trim();
    if (!path) continue; // empty rows are dropped silently
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
      sources.push({
        ...baseFields,
        kind: 'git-remote',
        repoUrl: path,
        ...(branch ? { defaultBranch: branch } : {}),
      });
    }
  }
  return { ok: true, sources };
}

const newSourceId = (): string => Math.random().toString(36).slice(2, 18);

type SourcesEditorProps = {
  value: SourceDraft[];
  onChange: (next: SourceDraft[]) => void;
};

export const SourcesEditor = memo(({ value, onChange }: SourcesEditorProps) => {
  const styles = useStyles();
  const [browseForUid, setBrowseForUid] = useState<string | null>(null);

  const updateRow = useCallback(
    (uid: string, patch: Partial<SourceDraft>) => {
      onChange(value.map((d) => (d.uid === uid ? { ...d, ...patch } : d)));
    },
    [value, onChange]
  );
  const removeRow = useCallback(
    (uid: string) => {
      onChange(value.filter((d) => d.uid !== uid));
    },
    [value, onChange]
  );
  const addRow = useCallback(() => {
    onChange([...value, emptyLocalDraft()]);
  }, [value, onChange]);

  const handleBrowseSelected = useCallback(
    (dir: string) => {
      if (!browseForUid) return;
      const current = value.find((d) => d.uid === browseForUid);
      if (!current) return;
      // Auto-derive mountName when the user hasn't typed one yet.
      const patch: Partial<SourceDraft> = { workspaceDir: dir };
      if (!current.mountName.trim()) {
        patch.mountName = deriveMountName({ ...current, workspaceDir: dir });
      }
      updateRow(browseForUid, patch);
      setBrowseForUid(null);
    },
    [browseForUid, value, updateRow]
  );

  return (
    <>
      <div className={styles.list}>
        {value.map((draft, idx) => {
          const isLocal = draft.kind === 'local';
          const placeholderMount = deriveMountName(draft);
          return (
            <div key={draft.uid} className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardTitle}>Source {idx + 1}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeRow(draft.uid)}
                  leftIcon={<Delete20Regular />}
                  isDisabled={value.length === 1}
                >
                  Remove
                </Button>
              </div>
              <div className={styles.row}>
                <div className={styles.field} style={{ flex: '0 0 130px' }}>
                  <label className={styles.label}>Kind</label>
                  <Select
                    value={draft.kind}
                    onChange={(e) => updateRow(draft.uid, { kind: e.target.value as SourceDraft['kind'] })}
                    className={styles.full}
                  >
                    <option value="local">Local</option>
                    <option value="git-remote">Git remote</option>
                  </Select>
                </div>
                <div className={styles.field} style={{ flex: '1 1 0' }}>
                  <label className={styles.label}>
                    Mount name <span className={styles.hint}>(folder under /workspace/)</span>
                  </label>
                  <Input
                    type="text"
                    value={draft.mountName}
                    onChange={(e) => updateRow(draft.uid, { mountName: e.target.value })}
                    placeholder={placeholderMount || 'e.g. launcher'}
                    className={styles.full}
                  />
                </div>
              </div>
              {isLocal ? (
                <div className={styles.field}>
                  <label className={styles.label}>Workspace directory</label>
                  <div className={styles.dirRow}>
                    <span className={styles.dirDisplay}>
                      {draft.workspaceDir || 'No directory selected'}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setBrowseForUid(draft.uid)}>
                      Browse
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className={styles.field}>
                    <label className={styles.label}>Repo URL</label>
                    <Input
                      type="text"
                      value={draft.repoUrl}
                      onChange={(e) => updateRow(draft.uid, { repoUrl: e.target.value })}
                      placeholder="https://github.com/owner/name"
                      className={styles.full}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>
                      Default branch <span className={styles.hint}>(optional)</span>
                    </label>
                    <Input
                      type="text"
                      value={draft.defaultBranch}
                      onChange={(e) => updateRow(draft.uid, { defaultBranch: e.target.value })}
                      placeholder="main"
                      className={styles.full}
                    />
                  </div>
                </>
              )}
            </div>
          );
        })}
        <Button
          size="sm"
          variant="ghost"
          onClick={addRow}
          leftIcon={<Add20Regular />}
          className={styles.addBtn}
        >
          Add source
        </Button>
      </div>
      <DirectoryBrowserDialog
        open={browseForUid !== null}
        onClose={() => setBrowseForUid(null)}
        onSelect={handleBrowseSelected}
        initialPath={
          browseForUid
            ? (value.find((d) => d.uid === browseForUid)?.workspaceDir ?? undefined)
            : undefined
        }
      />
    </>
  );
});
SourcesEditor.displayName = 'SourcesEditor';
