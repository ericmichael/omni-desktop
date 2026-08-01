import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { memo } from 'react';

import type {
  GitDiffFile,
  GitDiffHunk,
  GitDiffResult,
  GitHunkRef,
  GitStatusEntry,
  GitStatusResult,
} from '@/renderer/omniagents-ui/rpc/git';

const useStyles = makeStyles({
  root: {
    display: 'grid',
    gridTemplateColumns: 'minmax(14rem, 0.8fr) minmax(20rem, 2fr)',
    minHeight: 0,
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rootGlass: { backgroundColor: 'transparent' },
  status: {
    overflowY: 'auto',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: tokens.spacingVerticalM,
  },
  diff: { overflow: 'auto', padding: tokens.spacingVerticalM },
  heading: { margin: `0 0 ${tokens.spacingVerticalS}`, fontSize: tokens.fontSizeBase400 },
  summary: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  statusRow: {
    display: 'grid',
    gridTemplateColumns: '2.5rem minmax(0, 1fr)',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} 0`,
  },
  statusRowSelected: { backgroundColor: tokens.colorSubtleBackgroundSelected },
  path: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' },
  file: { marginBottom: tokens.spacingVerticalL },
  fileHeader: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS, marginLeft: 'auto' },
  button: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    ':disabled': { cursor: 'default', opacity: 0.6 },
  },
  hunk: {
    marginTop: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  hunkHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXS,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: 'monospace',
  },
  code: { margin: 0, fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 },
  line: { display: 'grid', gridTemplateColumns: '3.5rem 3.5rem 1rem minmax(max-content, 1fr)', whiteSpace: 'pre' },
  lineNumber: { color: tokens.colorNeutralForeground3, textAlign: 'right', paddingRight: tokens.spacingHorizontalS },
  add: { backgroundColor: tokens.colorPaletteGreenBackground1 },
  delete: { backgroundColor: tokens.colorPaletteRedBackground1 },
  empty: { color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalL, textAlign: 'center' },
});

export type GitStatusDiffViewProps = {
  status: GitStatusResult;
  diff: GitDiffResult;
  diffHeading?: string;
  onOpenFile?: (path: string, line?: number) => void;
  onSelectFile?: (path: string) => void;
  selectedPath?: string | null;
  actionsDisabled?: boolean;
  isGlass?: boolean;
  onStage?: (selection: {
    paths?: string[];
    hunks?: GitHunkRef[];
    contextLines: number;
    mode: 'worktree' | 'head';
  }) => void;
  onUnstage?: (selection: { paths?: string[]; hunks?: GitHunkRef[]; contextLines: number }) => void;
  onDiscard?: (selection: { paths?: string[]; hunks?: GitHunkRef[]; contextLines: number }) => void;
};

function statusLabel(entry: GitStatusEntry): string {
  if (entry.index_status === 'unmerged' || entry.worktree_status === 'unmerged') {
    return 'Conflict';
  }
  if (entry.staged && entry.unstaged) {
    return 'Both';
  }
  if (entry.staged) {
    return 'Staged';
  }
  return entry.worktree_status.replace('_', ' ');
}

function linePrefix(origin: GitDiffHunk['lines'][number]['origin']): string {
  if (origin === 'add') {
    return '+';
  }
  if (origin === 'delete') {
    return '-';
  }
  if (origin === 'no_newline') {
    return '\\';
  }
  return ' ';
}

function firstChangedLine(file: GitDiffFile): number | undefined {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.origin === 'add' && line.new_lineno !== null) {
        return line.new_lineno;
      }
      if (line.origin === 'delete' && line.old_lineno !== null) {
        return line.old_lineno;
      }
    }
  }
  return undefined;
}

const HunkView = ({
  file,
  hunk,
  mode,
  contextLines,
  onStage,
  onUnstage,
  onDiscard,
  actionsDisabled,
}: {
  file: GitDiffFile;
  hunk: GitDiffHunk;
  mode: GitDiffResult['mode'];
  contextLines: number;
  onStage: GitStatusDiffViewProps['onStage'];
  onUnstage: GitStatusDiffViewProps['onUnstage'];
  onDiscard: GitStatusDiffViewProps['onDiscard'];
  actionsDisabled: boolean;
}) => {
  const styles = useStyles();
  const ref = { path: file.path, hunk_id: hunk.hunk_id };
  const stageMode = mode === 'head' ? 'head' : 'worktree';
  return (
    <section className={styles.hunk} aria-label={`Changes in ${file.path}, hunk ${hunk.index + 1}`}>
      <header className={styles.hunkHeader}>
        <span>{hunk.header}</span>
        {hunk.section_heading && <span>{hunk.section_heading}</span>}
        {mode !== 'range' && (onStage || onUnstage || onDiscard) && (
          <span className={styles.actions}>
            {mode === 'staged' && onUnstage ? (
              <button
                className={styles.button}
                type="button"
                disabled={actionsDisabled}
                onClick={() => onUnstage?.({ hunks: [ref], contextLines })}
              >
                Unstage hunk
              </button>
            ) : onStage ? (
              <button
                className={styles.button}
                type="button"
                disabled={actionsDisabled}
                onClick={() => onStage?.({ hunks: [ref], contextLines, mode: stageMode })}
              >
                Stage hunk
              </button>
            ) : null}
            {mode === 'worktree' && onDiscard && (
              <button
                className={styles.button}
                type="button"
                disabled={actionsDisabled}
                onClick={() => onDiscard?.({ hunks: [ref], contextLines })}
              >
                Discard hunk
              </button>
            )}
          </span>
        )}
      </header>
      <pre className={styles.code} aria-label={`Diff lines for ${file.path}`}>
        {hunk.lines.map((line, index) => (
          <span
            className={`${styles.line} ${line.origin === 'add' ? styles.add : ''} ${line.origin === 'delete' ? styles.delete : ''}`}
            data-origin={line.origin}
            key={`${hunk.hunk_id}:${index}`}
          >
            <span className={styles.lineNumber} aria-hidden="true">
              {line.old_lineno ?? ''}
            </span>
            <span className={styles.lineNumber} aria-hidden="true">
              {line.new_lineno ?? ''}
            </span>
            <span aria-hidden="true">{linePrefix(line.origin)}</span>
            <span>{line.content}</span>
          </span>
        ))}
      </pre>
    </section>
  );
};

export const GitStatusDiffView = memo(
  ({
    status,
    diff,
    diffHeading,
    onOpenFile,
    onSelectFile,
    selectedPath,
    actionsDisabled = false,
    isGlass,
    onStage,
    onUnstage,
    onDiscard,
  }: GitStatusDiffViewProps) => {
    const styles = useStyles();
    const changed = [...status.entries];
    const known = new Set(changed.map((entry) => entry.path));
    for (const path of status.untracked) {
      if (!known.has(path)) {
        changed.push({
          path,
          orig_path: null,
          xy: '??',
          index_status: 'unmodified',
          worktree_status: 'added',
          staged: false,
          unstaged: true,
          submodule: false,
          similarity: null,
          unmerged: null,
        });
      }
    }
    const branch = status.head.branch ?? (status.head.unborn ? 'New repository' : 'Detached HEAD');

    return (
      <div
        className={mergeClasses(styles.root, isGlass && styles.rootGlass)}
        role="region"
        aria-label="Source control changes"
      >
        <section className={styles.status} aria-labelledby="git-changes-heading">
          <h2 className={styles.heading} id="git-changes-heading">
            Changes
          </h2>
          <p className={styles.summary} aria-live="polite">
            {branch} · {changed.length} changed {changed.length === 1 ? 'file' : 'files'}
            {status.upstream ? ` · ${status.upstream.ahead} ahead, ${status.upstream.behind} behind` : ''}
          </p>
          {changed.length === 0 ? (
            <p className={styles.empty}>Working tree clean</p>
          ) : (
            <ul className={styles.list} aria-label="Changed files">
              {changed.map((entry) => (
                <li
                  className={mergeClasses(styles.statusRow, selectedPath === entry.path && styles.statusRowSelected)}
                  key={`${entry.xy}:${entry.path}`}
                >
                  <span aria-label={`Status: ${statusLabel(entry)}`}>{entry.xy}</span>
                  {onSelectFile || onOpenFile ? (
                    <button
                      className={`${styles.button} ${styles.path}`}
                      type="button"
                      aria-pressed={selectedPath === entry.path}
                      onClick={() => (onSelectFile ?? onOpenFile)?.(entry.path)}
                    >
                      {entry.path}
                    </button>
                  ) : (
                    <span className={styles.path}>{entry.path}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.diff} aria-labelledby="git-diff-heading">
          <h2 className={styles.heading} id="git-diff-heading">
            {diffHeading ??
              (diff.mode === 'staged'
                ? 'Staged diff'
                : diff.mode === 'range'
                  ? 'Revision range diff'
                  : 'Working tree diff')}
          </h2>
          {diff.context_lines_clamped && <p role="status">Diff context was limited to {diff.context_lines} lines.</p>}
          {diff.files.length === 0 ? (
            <p className={styles.empty}>No changes in this view</p>
          ) : (
            diff.files.map((file) => (
              <article className={styles.file} key={file.path} aria-label={`Diff for ${file.path}`}>
                <header className={styles.fileHeader}>
                  <h3 className={styles.path}>{file.path}</h3>
                  <span>{file.binary ? 'Binary' : `+${file.added_lines ?? 0} −${file.deleted_lines ?? 0}`}</span>
                  {(onOpenFile || (diff.mode !== 'range' && (onStage || onUnstage || onDiscard))) && (
                    <span className={styles.actions}>
                      {onOpenFile && (
                        <button
                          aria-label={`Open ${file.path}`}
                          className={styles.button}
                          type="button"
                          onClick={() => onOpenFile(file.path, firstChangedLine(file))}
                        >
                          Open
                        </button>
                      )}
                      {diff.mode === 'staged' && onUnstage ? (
                        <button
                          className={styles.button}
                          type="button"
                          disabled={actionsDisabled}
                          onClick={() => onUnstage?.({ paths: [file.path], contextLines: diff.context_lines })}
                        >
                          Unstage file
                        </button>
                      ) : diff.mode !== 'range' && onStage ? (
                        <button
                          className={styles.button}
                          type="button"
                          disabled={actionsDisabled}
                          onClick={() =>
                            onStage?.({
                              paths: [file.path],
                              contextLines: diff.context_lines,
                              mode: diff.mode === 'head' ? 'head' : 'worktree',
                            })
                          }
                        >
                          Stage file
                        </button>
                      ) : null}
                      {diff.mode === 'worktree' && onDiscard && (
                        <button
                          className={styles.button}
                          type="button"
                          disabled={actionsDisabled}
                          onClick={() => onDiscard?.({ paths: [file.path], contextLines: diff.context_lines })}
                        >
                          Discard file
                        </button>
                      )}
                    </span>
                  )}
                </header>
                {file.unmerged && <p role="alert">This file has unresolved merge conflicts.</p>}
                {!file.hunk_selectable && file.hunks.length > 0 && (
                  <p role="note">This file can only be changed as a whole.</p>
                )}
                {file.hunk_selectable &&
                  file.hunks.map((hunk) => (
                    <HunkView
                      key={hunk.hunk_id}
                      file={file}
                      hunk={hunk}
                      mode={diff.mode}
                      contextLines={diff.context_lines}
                      onStage={onStage}
                      onUnstage={onUnstage}
                      onDiscard={onDiscard}
                      actionsDisabled={actionsDisabled}
                    />
                  ))}
              </article>
            ))
          )}
        </section>
      </div>
    );
  }
);
GitStatusDiffView.displayName = 'GitStatusDiffView';
