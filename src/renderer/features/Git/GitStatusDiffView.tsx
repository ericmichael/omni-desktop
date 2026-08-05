import './GitStatusDiffView.css';

import { memo } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { ButtonGroup } from '@/renderer/ds/ui/button-group';
import { Toggle } from '@/renderer/ds/ui/toggle';
import type {
  GitDiffFile,
  GitDiffHunk,
  GitDiffResult,
  GitHunkRef,
  GitStatusEntry,
  GitStatusResult,
} from '@/renderer/omniagents-ui/rpc/git';

export type GitStatusDiffViewProps = {
  status: GitStatusResult;
  diff: GitDiffResult;
  diffHeading?: string;
  onOpenFile?: (path: string, line?: number) => void;
  onSelectFile?: (path: string) => void;
  selectedPath?: string | null;
  actionsDisabled?: boolean;
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
  const ref = { path: file.path, hunk_id: hunk.hunk_id };
  const stageMode = mode === 'head' ? 'head' : 'worktree';
  return (
    <section
      className="mt-2 border border-border rounded-lg overflow-hidden"
      aria-label={`Changes in ${file.path}, hunk ${hunk.index + 1}`}
    >
      <header className="flex items-center gap-2 p-1 bg-muted font-mono">
        <span>{hunk.header}</span>
        {hunk.section_heading && <span>{hunk.section_heading}</span>}
        {mode !== 'range' && (onStage || onUnstage || onDiscard) && (
          <ButtonGroup className="ml-auto">
            {mode === 'staged' && onUnstage ? (
              <Button
                variant="outline"
                size="xs"
                disabled={actionsDisabled}
                onClick={() => onUnstage?.({ hunks: [ref], contextLines })}
              >
                Unstage hunk
              </Button>
            ) : onStage ? (
              <Button
                variant="outline"
                size="xs"
                disabled={actionsDisabled}
                onClick={() => onStage?.({ hunks: [ref], contextLines, mode: stageMode })}
              >
                Stage hunk
              </Button>
            ) : null}
            {mode === 'worktree' && onDiscard && (
              <Button
                variant="outline"
                size="xs"
                disabled={actionsDisabled}
                onClick={() => onDiscard?.({ hunks: [ref], contextLines })}
              >
                Discard hunk
              </Button>
            )}
          </ButtonGroup>
        )}
      </header>
      <pre className="m-0 font-mono text-xs" aria-label={`Diff lines for ${file.path}`}>
        {hunk.lines.map((line, index) => (
          <span
            className={`omni-git-diff-line grid whitespace-pre ${line.origin === 'add' ? 'bg-success/10' : ''} ${line.origin === 'delete' ? 'bg-destructive/10' : ''}`}
            data-origin={line.origin}
            key={`${hunk.hunk_id}:${index}`}
          >
            <span className="text-muted-foreground text-right pr-2" aria-hidden="true">
              {line.old_lineno ?? ''}
            </span>
            <span className="text-muted-foreground text-right pr-2" aria-hidden="true">
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
    onStage,
    onUnstage,
    onDiscard,
  }: GitStatusDiffViewProps) => {
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
        className="omni-git-diff-layout grid min-h-0 bg-card text-foreground"
        role="region"
        aria-label="Source control changes"
      >
        <section className="overflow-y-auto border-r border-border p-4" aria-labelledby="git-changes-heading">
          <h2 className="mb-2 text-base" id="git-changes-heading">
            Changes
          </h2>
          <p className="text-muted-foreground text-xs" aria-live="polite">
            {branch} · {changed.length} changed {changed.length === 1 ? 'file' : 'files'}
            {status.upstream ? ` · ${status.upstream.ahead} ahead, ${status.upstream.behind} behind` : ''}
          </p>
          {changed.length === 0 ? (
            <p className="text-muted-foreground p-5 text-center">Working tree clean</p>
          ) : (
            <ul className="list-none m-0 p-0" aria-label="Changed files">
              {changed.map((entry) => (
                <li
                  className={cn('omni-git-file-row grid gap-2 py-1', selectedPath === entry.path && 'bg-accent')}
                  key={`${entry.xy}:${entry.path}`}
                >
                  <span aria-label={`Status: ${statusLabel(entry)}`}>{entry.xy}</span>
                  {onSelectFile || onOpenFile ? (
                    <Toggle
                      className={`${'border border-border rounded-lg bg-background text-foreground cursor-pointer disabled:cursor-default disabled:opacity-60'} ${'overflow-hidden text-ellipsis whitespace-nowrap font-mono'}`}
                      pressed={selectedPath === entry.path}
                      onClick={() => (onSelectFile ?? onOpenFile)?.(entry.path)}
                    >
                      {entry.path}
                    </Toggle>
                  ) : (
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono">{entry.path}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="overflow-auto p-4" aria-labelledby="git-diff-heading">
          <h2 className="mb-2 text-base" id="git-diff-heading">
            {diffHeading ??
              (diff.mode === 'staged'
                ? 'Staged diff'
                : diff.mode === 'range'
                  ? 'Revision range diff'
                  : 'Working tree diff')}
          </h2>
          {diff.context_lines_clamped && <p role="status">Diff context was limited to {diff.context_lines} lines.</p>}
          {diff.files.length === 0 ? (
            <p className="text-muted-foreground p-5 text-center">No changes in this view</p>
          ) : (
            diff.files.map((file) => (
              <article className="mb-5" key={file.path} aria-label={`Diff for ${file.path}`}>
                <header className="flex items-baseline gap-2">
                  <h3 className="overflow-hidden text-ellipsis whitespace-nowrap font-mono">{file.path}</h3>
                  <span>{file.binary ? 'Binary' : `+${file.added_lines ?? 0} −${file.deleted_lines ?? 0}`}</span>
                  {(onOpenFile || (diff.mode !== 'range' && (onStage || onUnstage || onDiscard))) && (
                    <ButtonGroup className="ml-auto">
                      {onOpenFile && (
                        <Button
                          aria-label={`Open ${file.path}`}
                          variant="outline"
                          size="xs"
                          onClick={() => onOpenFile(file.path, firstChangedLine(file))}
                        >
                          Open
                        </Button>
                      )}
                      {diff.mode === 'staged' && onUnstage ? (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={actionsDisabled}
                          onClick={() => onUnstage?.({ paths: [file.path], contextLines: diff.context_lines })}
                        >
                          Unstage file
                        </Button>
                      ) : diff.mode !== 'range' && onStage ? (
                        <Button
                          variant="outline"
                          size="xs"
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
                        </Button>
                      ) : null}
                      {diff.mode === 'worktree' && onDiscard && (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={actionsDisabled}
                          onClick={() => onDiscard?.({ paths: [file.path], contextLines: diff.context_lines })}
                        >
                          Discard file
                        </Button>
                      )}
                    </ButtonGroup>
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
