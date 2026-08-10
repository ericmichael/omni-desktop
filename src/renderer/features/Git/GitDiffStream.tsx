import { memo, useCallback } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { ButtonGroup } from '@/renderer/ds/ui/button-group';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/ds/ui/empty';
import type {
  GitDiffFile,
  GitDiffHunk,
  GitFileSelection,
  GitSelection,
  GitStatusEntry,
} from '@/renderer/omniagents-ui/rpc/git';

import { type ChangeBadge, humanFileStatus, linesFromHunk, statusBadge } from './diff-model';
import { DiffLines, DiffSection, useDiffTokens } from './DiffView';

/**
 * The Git app's diff pane: every file of the current view as a sticky,
 * collapsible, Shiki-highlighted section (the Review app's presentation)
 * with stage/unstage/discard actions on files and hunks. Data and mutation
 * state live with the surface; this component only renders and calls back.
 */

export type GitStreamMode = 'worktree' | 'staged' | 'session';

export type GitDiffStreamProps = {
  files: GitDiffFile[];
  entriesByPath: ReadonlyMap<string, GitStatusEntry>;
  conflicted: readonly string[];
  mode: GitStreamMode;
  contextLines: number;
  collapsedPaths: ReadonlySet<string>;
  onSectionOpenChange: (path: string, open: boolean) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onStage?: (selection: GitSelection) => void;
  onUnstage?: (selection: GitFileSelection) => void;
  onDiscard?: (selection: GitFileSelection) => void;
  actionsDisabled?: boolean;
};

const CHANGE_GLYPH: Partial<Record<GitDiffFile['change'], string>> = {
  modified: 'M',
  type_changed: 'T',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  unmerged: 'U',
};

const CHANGE_CLASS: Partial<Record<GitDiffFile['change'], string>> = {
  added: 'text-success',
  deleted: 'text-destructive',
  unmerged: 'text-destructive',
};

/** Badge from the porcelain entry when we have one (it knows staging
 *  state); otherwise derived from the diff file's change type. */
function badgeForFile(
  file: GitDiffFile,
  entriesByPath: GitDiffStreamProps['entriesByPath'],
  conflicted: GitDiffStreamProps['conflicted']
): ChangeBadge {
  const entry = entriesByPath.get(file.path);
  if (entry) {
    return statusBadge(entry, conflicted.includes(file.path));
  }
  return {
    text: CHANGE_GLYPH[file.change] ?? '·',
    className: CHANGE_CLASS[file.change] ?? 'text-primary',
    title: humanFileStatus(file.change),
  };
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

function fileNotes(file: GitDiffFile): string[] {
  const notes: string[] = [];
  if (file.binary) {
    notes.push('binary');
  }
  if (file.submodule) {
    notes.push('submodule');
  }
  if (!file.hunk_selectable && file.hunks.length > 0) {
    notes.push('whole file only');
  }
  return notes;
}

const HunkBlock = ({
  file,
  hunk,
  mode,
  contextLines,
  onStage,
  onUnstage,
  onDiscard,
  actionsDisabled,
  showActions,
}: {
  file: GitDiffFile;
  hunk: GitDiffHunk;
  mode: GitStreamMode;
  contextLines: number;
  onStage: GitDiffStreamProps['onStage'];
  onUnstage: GitDiffStreamProps['onUnstage'];
  onDiscard: GitDiffStreamProps['onDiscard'];
  actionsDisabled: boolean;
  showActions: boolean;
}) => {
  // Mounted only while the section is expanded (Collapsible unmounts its
  // content), so tokenizing unconditionally costs nothing when collapsed.
  const lines = linesFromHunk(hunk);
  const tokens = useDiffTokens(file.path, lines, true);
  const ref = { path: file.path, hunk_id: hunk.hunk_id };
  const range = `Lines ${hunk.new_start}–${hunk.new_start + Math.max(hunk.new_lines - 1, 0)}`;
  return (
    <section aria-label={`Changes in ${file.path}, hunk ${hunk.index + 1}`}>
      <header className="flex min-h-6 items-center gap-2 border-y border-border/60 bg-muted/40 px-2 py-0.5">
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {hunk.section_heading || range}
        </span>
        {showActions && (onStage || onUnstage || onDiscard) ? (
          <ButtonGroup className="ml-auto">
            {mode === 'staged' && onUnstage ? (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={actionsDisabled}
                onClick={() => onUnstage({ hunks: [ref], contextLines })}
              >
                Unstage hunk
              </Button>
            ) : mode === 'worktree' && onStage ? (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={actionsDisabled}
                onClick={() => onStage({ hunks: [ref], contextLines, mode: 'worktree' })}
              >
                Stage hunk
              </Button>
            ) : null}
            {mode === 'worktree' && onDiscard ? (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={actionsDisabled}
                onClick={() => onDiscard({ hunks: [ref], contextLines })}
              >
                Discard hunk
              </Button>
            ) : null}
          </ButtonGroup>
        ) : null}
      </header>
      <DiffLines lines={lines} tokens={tokens} />
    </section>
  );
};

const FileStreamSection = ({
  file,
  badge,
  mode,
  contextLines,
  open,
  onSectionOpenChange,
  onOpenFile,
  onStage,
  onUnstage,
  onDiscard,
  actionsDisabled,
}: {
  file: GitDiffFile;
  badge: ChangeBadge;
  mode: GitStreamMode;
  contextLines: number;
  open: boolean;
  onSectionOpenChange: GitDiffStreamProps['onSectionOpenChange'];
  onOpenFile: GitDiffStreamProps['onOpenFile'];
  onStage: GitDiffStreamProps['onStage'];
  onUnstage: GitDiffStreamProps['onUnstage'];
  onDiscard: GitDiffStreamProps['onDiscard'];
  actionsDisabled: boolean;
}) => {
  const openFile = useCallback(() => onOpenFile?.(file.path, firstChangedLine(file)), [file, onOpenFile]);
  const handleOpenChange = useCallback(
    (next: boolean) => onSectionOpenChange(file.path, next),
    [file.path, onSectionOpenChange]
  );
  const canOpen = file.change !== 'deleted';
  const showMutations = mode !== 'session';
  return (
    <DiffSection
      path={file.path}
      badge={badge}
      additions={file.binary ? null : (file.added_lines ?? null)}
      deletions={file.binary ? null : (file.deleted_lines ?? null)}
      notes={fileNotes(file)}
      open={open}
      onOpenChange={handleOpenChange}
      onOpenFile={onOpenFile && canOpen ? openFile : undefined}
      headerActions={
        showMutations ? (
          <ButtonGroup className="shrink-0">
            {mode === 'staged' && onUnstage ? (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={actionsDisabled}
                aria-label={`Unstage ${file.path}`}
                onClick={() => onUnstage({ paths: [file.path], contextLines })}
              >
                Unstage
              </Button>
            ) : mode === 'worktree' && onStage ? (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={actionsDisabled}
                aria-label={`Stage ${file.path}`}
                onClick={() => onStage({ paths: [file.path], contextLines, mode: 'worktree' })}
              >
                Stage
              </Button>
            ) : null}
            {mode === 'worktree' && onDiscard ? (
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={actionsDisabled}
                aria-label={`Discard ${file.path}`}
                onClick={() => onDiscard({ paths: [file.path], contextLines })}
              >
                Discard
              </Button>
            ) : null}
          </ButtonGroup>
        ) : undefined
      }
    >
      {file.unmerged ? (
        <p className="px-9 py-1 text-xs text-destructive" role="alert">
          This file has unresolved merge conflicts.
        </p>
      ) : null}
      {file.hunks.length > 0 ? (
        file.hunks.map((hunk) => (
          <HunkBlock
            key={hunk.hunk_id}
            file={file}
            hunk={hunk}
            mode={mode}
            contextLines={contextLines}
            onStage={onStage}
            onUnstage={onUnstage}
            onDiscard={onDiscard}
            actionsDisabled={actionsDisabled}
            showActions={showMutations && file.hunk_selectable}
          />
        ))
      ) : (
        <p className="px-9 pb-2 text-xs text-muted-foreground">
          {file.binary
            ? 'Binary file — no text hunks.'
            : file.submodule
              ? 'Submodule change.'
              : 'No textual changes to show.'}
        </p>
      )}
    </DiffSection>
  );
};

export const GitDiffStream = memo(
  ({
    files,
    entriesByPath,
    conflicted,
    mode,
    contextLines,
    collapsedPaths,
    onSectionOpenChange,
    onOpenFile,
    onStage,
    onUnstage,
    onDiscard,
    actionsDisabled = false,
  }: GitDiffStreamProps) => {
    if (files.length === 0) {
      return (
        <Empty className="h-full rounded-none border-0" role="status">
          <EmptyHeader>
            <EmptyTitle>
              {mode === 'staged' ? 'Nothing staged' : mode === 'session' ? 'No session changes' : 'Working tree clean'}
            </EmptyTitle>
            <EmptyDescription>
              {mode === 'staged'
                ? 'Stage files or hunks from the Working tree view to build a commit.'
                : 'Changes land here as they happen.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    return (
      <div role="region" aria-label="Source control changes">
        {files.map((file) => (
          <FileStreamSection
            key={file.path}
            file={file}
            badge={badgeForFile(file, entriesByPath, conflicted)}
            mode={mode}
            contextLines={contextLines}
            open={!collapsedPaths.has(file.path)}
            onSectionOpenChange={onSectionOpenChange}
            onOpenFile={onOpenFile}
            onStage={onStage}
            onUnstage={onUnstage}
            onDiscard={onDiscard}
            actionsDisabled={actionsDisabled}
          />
        ))}
      </div>
    );
  }
);
GitDiffStream.displayName = 'GitDiffStream';
