import { memo, useMemo, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import { Textarea } from '@/renderer/ds/ui/textarea';
import type { GitStatusEntry, GitStatusResult } from '@/renderer/omniagents-ui/rpc/git';

import { statusBadge } from './diff-model';
import type { GitMutations } from './use-git-mutations';

/**
 * The Git app's sidebar: the commit box first (it is the most common
 * action, not a buried tab), then the complete change list grouped the way
 * git thinks — conflicts, staged, working tree. Rows navigate the diff
 * stream; staging happens on the stream's file/hunk actions or the group
 * "all" buttons here.
 */

export type GitSidebarProps = {
  status: GitStatusResult;
  entries: GitStatusEntry[];
  contextLines: number;
  canCommit: boolean;
  canStage: boolean;
  canUnstage: boolean;
  disabled?: boolean;
  mutations: GitMutations;
  onSelectFile: (path: string) => void;
};

function FileRow({
  entry,
  conflicted,
  onSelect,
}: {
  entry: GitStatusEntry;
  conflicted: boolean;
  onSelect: (path: string) => void;
}) {
  const badge = statusBadge(entry, conflicted);
  const separator = entry.path.lastIndexOf('/');
  const name = separator === -1 ? entry.path : entry.path.slice(separator + 1);
  const dir = separator === -1 ? null : entry.path.slice(0, separator);
  return (
    <li>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-accent/50"
        title={entry.path}
        onClick={() => onSelect(entry.path)}
      >
        <span className={cn('shrink-0 font-mono text-xs font-semibold', badge.className)} title={badge.title}>
          {badge.text}
        </span>
        <span className="min-w-0 truncate text-xs text-foreground">{name}</span>
        {dir ? <span className="min-w-0 truncate text-[10px] text-muted-foreground">{dir}</span> : null}
      </button>
    </li>
  );
}

function Group({
  label,
  entries,
  conflictedPaths,
  action,
  onSelectFile,
}: {
  label: string;
  entries: GitStatusEntry[];
  conflictedPaths: readonly string[];
  action?: { label: string; disabled: boolean; onClick: () => void };
  onSelectFile: (path: string) => void;
}) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <section aria-label={label}>
      <div className="flex items-center gap-1 px-1.5 pt-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
          {label} · {entries.length}
        </span>
        {action ? (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto h-5 px-1.5 text-[11px] text-muted-foreground"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ) : null}
      </div>
      <ul className="m-0 list-none p-0">
        {entries.map((entry) => (
          <FileRow
            key={entry.path}
            entry={entry}
            conflicted={conflictedPaths.includes(entry.path)}
            onSelect={onSelectFile}
          />
        ))}
      </ul>
    </section>
  );
}

export const GitSidebar = memo(
  ({
    status,
    entries,
    contextLines,
    canCommit,
    canStage,
    canUnstage,
    disabled = false,
    mutations,
    onSelectFile,
  }: GitSidebarProps) => {
    const [message, setMessage] = useState('');
    const [amend, setAmend] = useState(false);

    const groups = useMemo(() => {
      const conflicts = entries.filter(
        (entry) =>
          status.conflicted.includes(entry.path) ||
          entry.index_status === 'unmerged' ||
          entry.worktree_status === 'unmerged'
      );
      const conflictPaths = new Set(conflicts.map((entry) => entry.path));
      return {
        conflicts,
        staged: entries.filter((entry) => entry.staged && !conflictPaths.has(entry.path)),
        unstaged: entries.filter((entry) => entry.unstaged && !conflictPaths.has(entry.path)),
      };
    }, [entries, status.conflicted]);

    const hasStaged = groups.staged.length > 0;
    const busy = mutations.busy !== null;
    const commitDisabled = disabled || busy || !message.trim() || (!hasStaged && !amend);

    const commit = async () => {
      if (commitDisabled) {
        return;
      }
      const committed = await mutations.commit(message.trim(), amend ? { amend: true } : {});
      if (committed) {
        setMessage('');
        setAmend(false);
      }
    };

    return (
      <div className="flex h-full min-h-0 flex-col bg-card">
        {canCommit ? (
          <div className="shrink-0 space-y-1.5 border-b border-border p-2">
            <Textarea
              aria-label="Commit message"
              value={message}
              rows={2}
              className="min-h-14 resize-none text-xs"
              placeholder={amend ? 'New commit message' : 'Commit message'}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void commit();
                }
              }}
            />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Checkbox checked={amend} onCheckedChange={(checked) => setAmend(checked === true)} />
                Amend
              </label>
              <Button size="sm" className="ml-auto h-6" disabled={commitDisabled} onClick={() => void commit()}>
                {amend ? 'Amend commit' : 'Commit'}
              </Button>
            </div>
            {!hasStaged && !amend ? (
              <p className="text-[11px] text-muted-foreground">Stage changes to commit.</p>
            ) : null}
          </div>
        ) : null}
        <ScrollArea className="min-h-0 flex-1">
          <nav aria-label="Changed files" className="p-1 pb-2">
            {entries.length === 0 ? (
              <p className="p-3 text-center text-xs text-muted-foreground">Working tree clean</p>
            ) : (
              <>
                <Group
                  label="Conflicts"
                  entries={groups.conflicts}
                  conflictedPaths={status.conflicted}
                  onSelectFile={onSelectFile}
                />
                <Group
                  label="Staged"
                  entries={groups.staged}
                  conflictedPaths={status.conflicted}
                  action={
                    canUnstage
                      ? {
                          label: 'Unstage all',
                          disabled: disabled || busy,
                          onClick: () =>
                            void mutations.unstage({
                              paths: groups.staged.map((entry) => entry.path),
                              contextLines,
                            }),
                        }
                      : undefined
                  }
                  onSelectFile={onSelectFile}
                />
                <Group
                  label="Changes"
                  entries={groups.unstaged}
                  conflictedPaths={status.conflicted}
                  action={
                    canStage
                      ? {
                          label: 'Stage all',
                          disabled: disabled || busy,
                          onClick: () =>
                            void mutations.stage({
                              paths: groups.unstaged.map((entry) => entry.path),
                              contextLines,
                              mode: 'worktree',
                            }),
                        }
                      : undefined
                  }
                  onSelectFile={onSelectFile}
                />
              </>
            )}
          </nav>
        </ScrollArea>
      </div>
    );
  }
);
GitSidebar.displayName = 'GitSidebar';
