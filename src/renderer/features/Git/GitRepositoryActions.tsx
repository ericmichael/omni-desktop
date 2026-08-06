import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/ds/ui/alert-dialog';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/ds/ui/collapsible';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect } from '@/renderer/ds/ui/native-select';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/renderer/ds/ui/tabs';
import { Textarea } from '@/renderer/ds/ui/textarea';
import type {
  GitBranch,
  GitClient,
  GitCommitSummary,
  GitConfirmation,
  GitConflict,
  GitMutationOutcome,
  GitResetMode,
  GitStatusResult,
  GitWorktree,
  WorkspaceRepo,
} from '@/renderer/omniagents-ui/rpc/git';

export type GitRepositoryCapabilities = {
  commit: boolean;
  log: boolean;
  branches: boolean;
  worktrees: boolean;
  conflicts: boolean;
  stage: boolean;
  checkout: boolean;
  reset: boolean;
  fetch: boolean;
  pull: boolean;
  push: boolean;
  progress: boolean;
};

type CommitOptions = { amend?: boolean };
type CheckoutOptions = { create?: boolean; startPoint?: string };
type ResetOptions = { mode?: GitResetMode; rev?: string };
type PushOptions = { forceWithLease?: boolean; setUpstream?: boolean };
type ConfirmationIntent =
  | { kind: 'commit'; message: string; options: CommitOptions }
  | { kind: 'checkout'; branch: string; options: CheckoutOptions }
  | { kind: 'reset'; options: ResetOptions }
  | { kind: 'push'; options: PushOptions };
type PendingConfirmation = ConfirmationIntent & { confirmation: GitConfirmation };

type Props = {
  client: GitClient;
  repo: WorkspaceRepo;
  status: GitStatusResult;
  capabilities: GitRepositoryCapabilities;
  disabled?: boolean;
  onChanged: () => void;
  onOpenFile?: (path: string, line?: number) => void;
  onMutationPendingChange?: (pending: boolean) => void;
};

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function confirmationText(pending: PendingConfirmation | null): string {
  if (!pending) {
    return '';
  }
  const details = Object.entries(pending.confirmation.impact)
    .map(([key, value]) => `${key.replaceAll('_', ' ')}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    .join('. ');
  return `${pending.confirmation.operation.replaceAll('_', ' ')} requires confirmation.${details ? ` ${details}.` : ''}`;
}

function firstTab(capabilities: GitRepositoryCapabilities): string {
  if (capabilities.commit) {
    return 'commit';
  }
  if (capabilities.log) {
    return 'history';
  }
  if (capabilities.branches) {
    return 'branches';
  }
  if (capabilities.worktrees) {
    return 'worktrees';
  }
  if (capabilities.conflicts) {
    return 'conflicts';
  }
  return 'advanced';
}

export function GitRepositoryActions({
  client,
  repo,
  status,
  capabilities,
  disabled = false,
  onChanged,
  onOpenFile,
  onMutationPendingChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [conflicts, setConflicts] = useState<GitConflict[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [startPoint, setStartPoint] = useState('');
  const [resetRevision, setResetRevision] = useState('HEAD');
  const [resetMode, setResetMode] = useState<GitResetMode>('mixed');
  const [pullRebase, setPullRebase] = useState(false);
  const [forceWithLease, setForceWithLease] = useState(false);
  const [setUpstream, setSetUpstream] = useState(status.upstream === null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);

  const staged = status.entries.some((entry) => entry.staged);
  const hasTools =
    capabilities.commit ||
    capabilities.log ||
    capabilities.branches ||
    capabilities.worktrees ||
    capabilities.conflicts ||
    capabilities.reset ||
    capabilities.fetch ||
    capabilities.pull ||
    capabilities.push;
  const refreshDetails = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!open) {
      return;
    }
    let alive = true;
    const reads: Promise<void>[] = [];
    if (capabilities.log) {
      reads.push(
        client.log(repo, { maxCount: 50 }).then((result) => {
          if (alive) {
            setCommits(result.commits);
          }
        })
      );
    }
    if (capabilities.branches) {
      reads.push(
        client.branches(repo, true).then((result) => {
          if (alive) {
            setBranches(result.branches);
          }
        })
      );
    }
    if (capabilities.worktrees) {
      reads.push(
        client.worktrees(repo).then((result) => {
          if (alive) {
            setWorktrees(result.worktrees);
          }
        })
      );
    }
    if (capabilities.conflicts) {
      reads.push(
        client.conflicts(repo).then((result) => {
          if (alive) {
            setConflicts(result.conflicts);
          }
        })
      );
    }
    if (reads.length > 0) {
      setBusy('Loading repository details');
      setError(null);
      void Promise.allSettled(reads).then((results) => {
        if (!alive) {
          return;
        }
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) {
          setError(message(failure.reason, 'Could not load all repository details.'));
        }
        setBusy(null);
      });
    }
    return () => {
      alive = false;
    };
  }, [
    capabilities.branches,
    capabilities.conflicts,
    capabilities.log,
    capabilities.worktrees,
    client,
    open,
    repo,
    revision,
  ]);

  useEffect(() => {
    if (!capabilities.progress) {
      return;
    }
    return client.onOperationProgress((event) => {
      if (event.repo !== repo) {
        return;
      }
      setProgress(
        `${event.operation} ${event.phase}${event.detail?.message ? `: ${String(event.detail.message)}` : ''}`
      );
    });
  }, [capabilities.progress, client, repo]);

  const changed = useCallback(() => {
    onChanged();
    refreshDetails();
  }, [onChanged, refreshDetails]);

  const completed = useCallback(
    (noticeText: string) => {
      setPendingConfirmation(null);
      setNotice(noticeText);
      changed();
    },
    [changed]
  );

  const rejected = useCallback(
    (errorText: string) => {
      setPendingConfirmation(null);
      setError(errorText);
      // Refresh the primary status/diff, but do not immediately launch the
      // auxiliary-detail loader: that loader's success must not erase the
      // rejection before the user can read it.
      onChanged();
    },
    [onChanged]
  );

  const handleOutcome = useCallback(
    <T,>(outcome: GitMutationOutcome<T>, pending: ConfirmationIntent, noticeText: string) => {
      if (outcome.kind === 'confirmation_required') {
        setPendingConfirmation({ ...pending, confirmation: outcome.confirmation } as PendingConfirmation);
      } else {
        completed(noticeText);
      }
    },
    [completed]
  );

  const run = useCallback(
    async (label: string, operation: () => Promise<void>) => {
      setBusy(label);
      onMutationPendingChange?.(true);
      setError(null);
      setNotice(null);
      try {
        await operation();
      } catch (caught) {
        setError(message(caught, `${label} failed.`));
      } finally {
        setBusy(null);
        onMutationPendingChange?.(false);
      }
    },
    [onMutationPendingChange]
  );

  const commit = useCallback(
    () =>
      run('Committing', async () => {
        const text = commitMessage.trim();
        const options: CommitOptions = amend ? { amend: true } : {};
        const outcome = await client.commit(repo, text, options);
        handleOutcome(
          outcome,
          { kind: 'commit', message: text, options },
          amend ? 'Commit amended.' : 'Changes committed.'
        );
        if (outcome.kind === 'completed') {
          setCommitMessage('');
        }
      }),
    [amend, client, commitMessage, handleOutcome, repo, run]
  );

  const checkout = useCallback(
    (branch: string, options: CheckoutOptions = {}) =>
      run('Checking out branch', async () => {
        const outcome = await client.checkout(repo, branch, options);
        handleOutcome(outcome, { kind: 'checkout', branch, options }, `Checked out ${branch}.`);
        if (outcome.kind === 'completed' && options.create) {
          setBranchName('');
        }
      }),
    [client, handleOutcome, repo, run]
  );

  const reset = useCallback(
    () =>
      run('Resetting repository', async () => {
        const options: ResetOptions = { mode: resetMode, rev: resetRevision.trim() || 'HEAD' };
        const outcome = await client.reset(repo, options);
        handleOutcome(outcome, { kind: 'reset', options }, `Repository reset (${resetMode}).`);
      }),
    [client, handleOutcome, repo, resetMode, resetRevision, run]
  );

  const push = useCallback(
    () =>
      run('Pushing', async () => {
        const options: PushOptions = {
          ...(forceWithLease ? { forceWithLease: true } : {}),
          ...(setUpstream ? { setUpstream: true } : {}),
        };
        const outcome = await client.push(repo, options);
        if (outcome.kind === 'confirmation_required') {
          setPendingConfirmation({ kind: 'push', options, confirmation: outcome.confirmation });
        } else if (outcome.result.ok) {
          completed('Push completed.');
        } else {
          rejected(
            outcome.result.rejected.length > 0
              ? `Push rejected: ${outcome.result.rejected.join(', ')}`
              : 'Push did not complete.'
          );
        }
      }),
    [client, completed, forceWithLease, rejected, repo, run, setUpstream]
  );

  const confirm = useCallback(() => {
    const pending = pendingConfirmation;
    if (!pending) {
      return;
    }
    void run('Confirming Git operation', async () => {
      let outcome: GitMutationOutcome<unknown>;
      if (pending.kind === 'commit') {
        outcome = await client.confirmCommit(repo, pending.message, pending.options, pending.confirmation);
      } else if (pending.kind === 'checkout') {
        outcome = await client.confirmCheckout(repo, pending.branch, pending.options, pending.confirmation);
      } else if (pending.kind === 'reset') {
        outcome = await client.confirmReset(repo, pending.options, pending.confirmation);
      } else {
        const pushOutcome = await client.confirmPush(repo, pending.options, pending.confirmation);
        if (pushOutcome.kind === 'confirmation_required') {
          setPendingConfirmation({ ...pending, confirmation: pushOutcome.confirmation });
        } else if (pushOutcome.result.ok) {
          completed('Push completed.');
        } else {
          rejected(
            pushOutcome.result.rejected.length > 0
              ? `Push rejected: ${pushOutcome.result.rejected.join(', ')}`
              : 'Push did not complete.'
          );
        }
        return;
      }
      if (outcome.kind === 'confirmation_required') {
        setPendingConfirmation({ ...pending, confirmation: outcome.confirmation });
      } else {
        completed(`${pending.kind.replaceAll('_', ' ')} completed.`);
      }
    });
  }, [client, completed, pendingConfirmation, rejected, repo, run]);

  const availableTabs = useMemo(
    () => [
      capabilities.commit,
      capabilities.log,
      capabilities.branches,
      capabilities.worktrees,
      capabilities.conflicts,
      capabilities.reset,
    ],
    [capabilities]
  );

  if (!hasTools) {
    return null;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border bg-muted/20">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <CollapsibleTrigger asChild>
          <Button size="sm" variant="outline">
            {open ? 'Hide repository tools' : 'Repository tools'}
          </Button>
        </CollapsibleTrigger>
        {capabilities.fetch ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || busy !== null}
            onClick={() =>
              void run('Fetching', async () =>
                completed(`Fetched ${(await client.fetch(repo)).updated_refs.length} ref updates.`)
              )
            }
          >
            Fetch
          </Button>
        ) : null}
        {capabilities.pull ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || busy !== null}
            onClick={() =>
              void run('Pulling', async () => {
                const result = await client.pull(repo, { rebase: pullRebase });
                if (result.conflicted.length) {
                  completed(`Pull has ${result.conflicted.length} conflicts.`);
                } else if (result.ok) {
                  completed('Pull completed.');
                } else {
                  rejected('Pull did not complete.');
                }
              })
            }
          >
            Pull
          </Button>
        ) : null}
        {capabilities.push ? (
          <Button size="sm" variant="ghost" disabled={disabled || busy !== null} onClick={() => void push()}>
            Push
          </Button>
        ) : null}
        {busy ? <span className="text-xs text-muted-foreground">{busy}…</span> : null}
        {progress ? <span className="text-xs text-muted-foreground">{progress}</span> : null}
      </div>
      <CollapsibleContent>
        <div className="border-t border-border px-4 py-3">
          {error ? (
            <Alert variant="destructive" className="mb-3">
              <TriangleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {notice ? (
            <Alert className="mb-3" role="status">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : null}
          {(capabilities.pull || capabilities.push) && (
            <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
              {capabilities.pull ? (
                <label className="flex items-center gap-2">
                  <Checkbox checked={pullRebase} onCheckedChange={(checked) => setPullRebase(checked === true)} />
                  Rebase when pulling
                </label>
              ) : null}
              {capabilities.push ? (
                <>
                  <label className="flex items-center gap-2">
                    <Checkbox checked={setUpstream} onCheckedChange={(checked) => setSetUpstream(checked === true)} />
                    Set upstream
                  </label>
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={forceWithLease}
                      onCheckedChange={(checked) => setForceWithLease(checked === true)}
                    />
                    Force with lease
                  </label>
                </>
              ) : null}
            </div>
          )}
          <Tabs key={`${repo}:${firstTab(capabilities)}`} defaultValue={firstTab(capabilities)}>
            <TabsList variant="line" className="max-w-full overflow-x-auto">
              {capabilities.commit ? <TabsTrigger value="commit">Commit</TabsTrigger> : null}
              {capabilities.log ? <TabsTrigger value="history">History</TabsTrigger> : null}
              {capabilities.branches ? <TabsTrigger value="branches">Branches</TabsTrigger> : null}
              {capabilities.worktrees ? <TabsTrigger value="worktrees">Worktrees</TabsTrigger> : null}
              {capabilities.conflicts ? <TabsTrigger value="conflicts">Conflicts</TabsTrigger> : null}
              {capabilities.reset ? <TabsTrigger value="advanced">Reset</TabsTrigger> : null}
            </TabsList>

            {capabilities.commit ? (
              <TabsContent value="commit" className="space-y-3 pt-2">
                <Textarea
                  aria-label="Commit message"
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder={amend ? 'New commit message' : 'Commit message'}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox checked={amend} onCheckedChange={(checked) => setAmend(checked === true)} /> Amend HEAD
                  </label>
                  <Button
                    size="sm"
                    disabled={disabled || busy !== null || !commitMessage.trim() || (!staged && !amend)}
                    onClick={() => void commit()}
                  >
                    {amend ? 'Amend commit' : 'Commit staged changes'}
                  </Button>
                  {!staged && !amend ? (
                    <span className="text-xs text-muted-foreground">Stage changes first.</span>
                  ) : null}
                </div>
              </TabsContent>
            ) : null}

            {capabilities.log ? (
              <TabsContent value="history" className="pt-2">
                <ScrollArea className="h-64 rounded-md border">
                  <ol className="divide-y divide-border">
                    {commits.map((commit) => (
                      <li key={commit.oid} className="space-y-1 px-3 py-2 text-sm">
                        <div className="flex items-center gap-2">
                          <code className="text-xs text-muted-foreground">{commit.short_oid}</code>
                          <span className="font-medium">{commit.subject}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {commit.author_name} · {commit.committed_at}
                        </div>
                        {commit.refs.length ? (
                          <div className="flex flex-wrap gap-1">
                            {commit.refs.map((ref) => (
                              <Badge key={ref} variant="outline">
                                {ref}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    ))}
                    {commits.length === 0 ? (
                      <li className="p-3 text-sm text-muted-foreground">No commits yet.</li>
                    ) : null}
                  </ol>
                </ScrollArea>
              </TabsContent>
            ) : null}

            {capabilities.branches ? (
              <TabsContent value="branches" className="space-y-3 pt-2">
                {capabilities.checkout ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="grid gap-1 text-xs text-muted-foreground">
                      New branch
                      <Input
                        aria-label="New branch"
                        value={branchName}
                        onChange={(event) => setBranchName(event.target.value)}
                      />
                    </label>
                    <label className="grid gap-1 text-xs text-muted-foreground">
                      Start point
                      <Input
                        aria-label="Start point"
                        value={startPoint}
                        onChange={(event) => setStartPoint(event.target.value)}
                        placeholder="HEAD"
                      />
                    </label>
                    <Button
                      size="sm"
                      disabled={disabled || busy !== null || !branchName.trim()}
                      onClick={() =>
                        void checkout(branchName.trim(), {
                          create: true,
                          ...(startPoint.trim() ? { startPoint: startPoint.trim() } : {}),
                        })
                      }
                    >
                      Create and checkout
                    </Button>
                  </div>
                ) : null}
                <div className="divide-y rounded-md border">
                  {branches.map((branch) => (
                    <div key={branch.ref} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                      {branch.current ? <Badge>Current</Badge> : null}
                      {branch.worktree_path ? <Badge variant="outline">In worktree</Badge> : null}
                      {branch.remote ? <Badge variant="secondary">Remote</Badge> : null}
                      {capabilities.checkout && !branch.current && !branch.remote && !branch.worktree_path ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disabled || busy !== null}
                          onClick={() => void checkout(branch.name)}
                        >
                          Checkout
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </TabsContent>
            ) : null}

            {capabilities.worktrees ? (
              <TabsContent value="worktrees" className="pt-2">
                <div className="divide-y rounded-md border">
                  {worktrees.map((worktree) => (
                    <div key={worktree.path} className="space-y-1 px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{worktree.branch ?? 'Detached HEAD'}</span>
                        {worktree.category === 'worker' ? <Badge variant="secondary">Worker</Badge> : null}
                        {worktree.locked ? <Badge variant="outline">Locked</Badge> : null}
                        {!worktree.accessible ? <Badge variant="destructive">Outside workspace</Badge> : null}
                      </div>
                      <code className="block break-all text-xs text-muted-foreground">{worktree.path}</code>
                      {worktree.lock_reason ? (
                        <div className="text-xs text-muted-foreground">{worktree.lock_reason}</div>
                      ) : null}
                    </div>
                  ))}
                  {worktrees.length === 0 ? (
                    <div className="p-3 text-sm text-muted-foreground">No worktrees found.</div>
                  ) : null}
                </div>
              </TabsContent>
            ) : null}

            {capabilities.conflicts ? (
              <TabsContent value="conflicts" className="space-y-3 pt-2">
                {conflicts.map((conflict) => (
                  <div key={conflict.path} className="space-y-2 rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{conflict.path}</span>
                      {onOpenFile ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onOpenFile(conflict.path, conflict.regions[0]?.start_line)}
                        >
                          Open file
                        </Button>
                      ) : null}
                      {capabilities.stage ? (
                        <Button
                          size="sm"
                          disabled={disabled || busy !== null}
                          onClick={() =>
                            void run('Marking conflict resolved', async () => {
                              await client.stage(repo, { paths: [conflict.path] });
                              completed(`Marked ${conflict.path} resolved.`);
                            })
                          }
                        >
                          Mark resolved
                        </Button>
                      ) : null}
                    </div>
                    {conflict.regions_available ? (
                      conflict.regions.map((region) => (
                        <div key={`${region.start_line}:${region.end_line}`} className="grid gap-2 md:grid-cols-2">
                          <pre className="overflow-auto rounded bg-muted p-2 text-xs">
                            <strong>{region.ours_label}</strong>
                            {'\n'}
                            {region.ours.join('\n')}
                          </pre>
                          <pre className="overflow-auto rounded bg-muted p-2 text-xs">
                            <strong>{region.theirs_label}</strong>
                            {'\n'}
                            {region.theirs.join('\n')}
                          </pre>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Conflict regions are unavailable; open the file to resolve it.
                      </p>
                    )}
                  </div>
                ))}
                {conflicts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No unresolved conflicts.</p>
                ) : null}
              </TabsContent>
            ) : null}

            {capabilities.reset ? (
              <TabsContent value="advanced" className="space-y-3 pt-2">
                <Alert>
                  <TriangleAlert />
                  <AlertDescription>
                    Reset changes repository state. Hard reset can permanently discard local work and requires server
                    confirmation.
                  </AlertDescription>
                </Alert>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    Revision
                    <Input
                      aria-label="Reset revision"
                      value={resetRevision}
                      onChange={(event) => setResetRevision(event.target.value)}
                    />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">
                    Mode
                    <NativeSelect
                      aria-label="Reset mode"
                      value={resetMode}
                      onChange={(event) => setResetMode(event.target.value as GitResetMode)}
                    >
                      <option value="soft">Soft</option>
                      <option value="mixed">Mixed</option>
                      <option value="hard">Hard</option>
                    </NativeSelect>
                  </label>
                  <Button
                    variant={resetMode === 'hard' ? 'destructive' : 'outline'}
                    size="sm"
                    disabled={disabled || busy !== null || !resetRevision.trim()}
                    onClick={() => void reset()}
                  >
                    Reset
                  </Button>
                </div>
              </TabsContent>
            ) : null}
          </Tabs>
          {availableTabs.every((available) => !available) ? (
            <p className="text-sm text-muted-foreground">Only remote operations are available for this runtime.</p>
          ) : null}
        </div>
      </CollapsibleContent>

      <AlertDialog open={pendingConfirmation !== null} onOpenChange={(next) => !next && setPendingConfirmation(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Git operation?</AlertDialogTitle>
            <AlertDialogDescription>{confirmationText(pendingConfirmation)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirm}>
              Confirm operation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Collapsible>
  );
}
