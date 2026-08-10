import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Checkbox } from '@/renderer/ds/ui/checkbox';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect } from '@/renderer/ds/ui/native-select';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/renderer/ds/ui/tabs';
import type {
  GitBranch,
  GitClient,
  GitCommitSummary,
  GitConflict,
  GitResetMode,
  GitWorktree,
  WorkspaceRepo,
} from '@/renderer/omniagents-ui/rpc/git';

import type { GitMutations } from './use-git-mutations';

/**
 * The Git app's repository tools: history, branches, worktrees, conflict
 * inspection, and reset — the low-frequency operations, opened on demand
 * from the toolbar. Committing lives in the sidebar and fetch/pull/push in
 * the toolbar; sync behavior options live here with the rest of the
 * repository controls.
 */

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

export type GitSyncOptions = { rebase: boolean; forceWithLease: boolean; setUpstream: boolean };

export type GitToolsPanelProps = {
  client: GitClient;
  repo: WorkspaceRepo;
  capabilities: GitRepositoryCapabilities;
  disabled?: boolean;
  mutations: GitMutations;
  /** Bumped by the surface after every successful mutation; re-reads details. */
  revision: number;
  syncOptions: GitSyncOptions;
  onSyncOptionsChange: (options: GitSyncOptions) => void;
  onOpenFile?: (path: string, line?: number) => void;
};

function firstTab(capabilities: GitRepositoryCapabilities): string {
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

export function GitToolsPanel({
  client,
  repo,
  capabilities,
  disabled = false,
  mutations,
  revision,
  syncOptions,
  onSyncOptionsChange,
  onOpenFile,
}: GitToolsPanelProps) {
  const [readError, setReadError] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [conflicts, setConflicts] = useState<GitConflict[]>([]);
  const [branchName, setBranchName] = useState('');
  const [startPoint, setStartPoint] = useState('');
  const [resetRevision, setResetRevision] = useState('HEAD');
  const [resetMode, setResetMode] = useState<GitResetMode>('mixed');

  const busy = mutations.busy !== null;

  useEffect(() => {
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
      setReadError(null);
      void Promise.allSettled(reads).then((results) => {
        if (!alive) {
          return;
        }
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) {
          setReadError(
            failure.reason instanceof Error && failure.reason.message
              ? failure.reason.message
              : 'Could not load all repository details.'
          );
        }
      });
    }
    return () => {
      alive = false;
    };
  }, [capabilities.branches, capabilities.conflicts, capabilities.log, capabilities.worktrees, client, repo, revision]);

  const hasTabs =
    capabilities.log || capabilities.branches || capabilities.worktrees || capabilities.conflicts || capabilities.reset;

  return (
    <div className="shrink-0 border-b border-border bg-muted/20 px-3 py-2">
      {readError ? (
        <Alert variant="destructive" className="mb-2">
          <TriangleAlert />
          <AlertDescription>{readError}</AlertDescription>
        </Alert>
      ) : null}
      {(capabilities.pull || capabilities.push) && (
        <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
          {capabilities.pull ? (
            <label className="flex items-center gap-2">
              <Checkbox
                checked={syncOptions.rebase}
                onCheckedChange={(checked) => onSyncOptionsChange({ ...syncOptions, rebase: checked === true })}
              />
              Rebase when pulling
            </label>
          ) : null}
          {capabilities.push ? (
            <>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={syncOptions.setUpstream}
                  onCheckedChange={(checked) => onSyncOptionsChange({ ...syncOptions, setUpstream: checked === true })}
                />
                Set upstream
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={syncOptions.forceWithLease}
                  onCheckedChange={(checked) =>
                    onSyncOptionsChange({ ...syncOptions, forceWithLease: checked === true })
                  }
                />
                Force with lease
              </label>
            </>
          ) : null}
        </div>
      )}
      {hasTabs ? (
        <Tabs key={`${repo}:${firstTab(capabilities)}`} defaultValue={firstTab(capabilities)}>
          <TabsList variant="line" className="max-w-full overflow-x-auto">
            {capabilities.log ? <TabsTrigger value="history">History</TabsTrigger> : null}
            {capabilities.branches ? <TabsTrigger value="branches">Branches</TabsTrigger> : null}
            {capabilities.worktrees ? <TabsTrigger value="worktrees">Worktrees</TabsTrigger> : null}
            {capabilities.conflicts ? <TabsTrigger value="conflicts">Conflicts</TabsTrigger> : null}
            {capabilities.reset ? <TabsTrigger value="advanced">Reset</TabsTrigger> : null}
          </TabsList>

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
                  {commits.length === 0 ? <li className="p-3 text-sm text-muted-foreground">No commits yet.</li> : null}
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
                    disabled={disabled || busy || !branchName.trim()}
                    onClick={() =>
                      void mutations
                        .checkout(branchName.trim(), {
                          create: true,
                          ...(startPoint.trim() ? { startPoint: startPoint.trim() } : {}),
                        })
                        .then(() => setBranchName(''))
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
                        disabled={disabled || busy}
                        onClick={() => void mutations.checkout(branch.name)}
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
                        disabled={disabled || busy}
                        onClick={() => void mutations.markResolved(conflict.path)}
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
                  disabled={disabled || busy || !resetRevision.trim()}
                  onClick={() => void mutations.reset({ mode: resetMode, rev: resetRevision.trim() || 'HEAD' })}
                >
                  Reset
                </Button>
              </div>
            </TabsContent>
          ) : null}
        </Tabs>
      ) : (
        <p className="text-sm text-muted-foreground">Only remote operations are available for this runtime.</p>
      )}
    </div>
  );
}
