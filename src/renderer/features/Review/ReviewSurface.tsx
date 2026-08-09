import './ReviewSurface.css';

import { useStore } from '@nanostores/react';
import {
  ChevronRightIcon,
  Folder,
  FolderOpen,
  PanelLeftIcon,
  RefreshCwIcon,
  SquareArrowOutUpRightIcon,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ThemedToken } from 'shiki';

import { cn } from '@/renderer/ds/cn';
import { Tree, TreeItem, TreeItemLayout, type TreeItemOpenChangeData } from '@/renderer/ds/Tree';
import { Alert, AlertDescription } from '@/renderer/ds/ui/alert';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/ds/ui/collapsible';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/renderer/ds/ui/resizable';
import { ScrollArea } from '@/renderer/ds/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/ds/ui/select';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { Toggle } from '@/renderer/ds/ui/toggle';
import { highlightCode, type TokenizedCode, TokenSpan } from '@/renderer/omniagents-ui/components/ai/code-block';
import {
  GitClient,
  type GitDiffResult,
  type GitListRepositoriesResult,
  type GitRepository,
  type GitStatusEntry,
  type GitStatusResult,
  type WorkspaceRepo,
} from '@/renderer/omniagents-ui/rpc/git';
import { useRPCClient, useRPCConnected } from '@/renderer/omniagents-ui/rpc-context';
import { $runDiffBySession } from '@/renderer/omniagents-ui/run-diff-store';
import type { RunDiffFile, RunDiffItem } from '@/shared/chat-types';
import type { ExecutionTarget } from '@/shared/types';

import {
  buildFileTree,
  firstAddedLine,
  languageForPath,
  linesFromHunks,
  numberUnified,
  type ReviewDiffLine,
  type ReviewTreeNode,
  splitUnifiedDiff,
  treeDirPaths,
} from './review-model';

/**
 * The Review sidecar app: a read-only, review-oriented pass over what
 * changed — the launcher port of the Ink TUI's Review screen, shaped like
 * an IDE diff viewer. Two scopes feed one presentation: "This turn"
 * renders the session's run-diff record (published into ``run-diff-store``
 * by the chat app); "Working tree" renders everything uncommitted (HEAD
 * diff + untracked) via the same Git RPCs the Git app uses. The file
 * sidebar is a synced, hideable table of contents; every file is a
 * collapsible section in one always-complete stream. Deliberately
 * read-only: staging, discarding, and committing live in the Git app.
 */

export type ReviewSurfaceProps = {
  executionTarget: ExecutionTarget;
  sessionId?: string;
  workspaceRoot?: string;
  /** Whether this persistent surface is currently visible in the dock. */
  active?: boolean;
  onOpenFile?: (path: string, line?: number) => void;
};

type ReviewScope = 'turn' | 'working';

const GIT_READ_OPERATIONS = ['git_list_repositories', 'git_status', 'git_diff'] as const;

/** Below this surface width the file sidebar defaults to hidden (the
 *  toggle still overrides) — sidecar columns are usually this narrow. */
const SIDEBAR_AUTO_HIDE_WIDTH = 576;

const CHANGE_GLYPH: Record<RunDiffFile['changeType'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
};

const CHANGE_CLASS: Record<RunDiffFile['changeType'], string> = {
  added: 'text-success',
  modified: 'text-primary',
  deleted: 'text-destructive',
};

/** One row of either scope, projected into the shared display grammar. */
type ReviewEntry = {
  path: string;
  badge: { text: string; className: string; title: string };
  additions: number | null;
  deletions: number | null;
  /** Capture caveats rendered as header chips ("opaque", "no baseline"). */
  notes: string[];
  lines: ReviewDiffLine[];
  /** Shown in place of lines when there are none. */
  emptyNote: string;
  canOpen: boolean;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function repositoryLabel(repository: GitRepository): string {
  const branch = repository.branch ?? (repository.detached ? 'detached' : 'new repository');
  return `${repository.repo} — ${branch}`;
}

function turnEntries(item: RunDiffItem): ReviewEntry[] {
  const byPath = splitUnifiedDiff(item.diff);
  return item.files.map((file) => {
    const raw = byPath.get(file.path);
    const lines = raw ? numberUnified(raw) : [];
    return {
      path: file.path,
      badge: {
        text: CHANGE_GLYPH[file.changeType],
        className: CHANGE_CLASS[file.changeType],
        title: file.changeType,
      },
      additions: file.opaque ? null : file.additions,
      deletions: file.opaque ? null : file.deletions,
      notes: [...(file.opaque ? ['opaque'] : []), ...(file.baselineUnknown ? ['no baseline'] : [])],
      lines,
      emptyNote: file.opaque
        ? 'Binary or oversized — no text hunks.'
        : 'Content not carried — the diff was truncated before this file.',
      canOpen: file.changeType !== 'deleted',
    };
  });
}

/** The two-character porcelain badge, colored by staging state — the same
 *  reading the Ink review sidebar gives (staged, mixed, conflict, …). */
function workingBadge(entry: GitStatusEntry, conflicted: boolean): ReviewEntry['badge'] {
  const text = entry.xy.replace(/ /g, '·');
  if (conflicted || entry.index_status === 'unmerged' || entry.worktree_status === 'unmerged') {
    return { text, className: 'text-destructive', title: 'Conflict' };
  }
  if (entry.xy === '??') {
    return { text, className: 'text-muted-foreground', title: 'Untracked' };
  }
  if (entry.staged && !entry.unstaged) {
    return { text, className: 'text-success', title: 'Staged' };
  }
  if (entry.staged && entry.unstaged) {
    return { text, className: 'text-warning', title: 'Staged, with unstaged edits' };
  }
  return { text, className: 'text-primary', title: 'Unstaged' };
}

function workingEntries(status: GitStatusResult, diff: GitDiffResult): ReviewEntry[] {
  const entries = [...status.entries];
  const known = new Set(entries.map((entry) => entry.path));
  for (const path of status.untracked) {
    if (!known.has(path)) {
      entries.push({
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
  return entries.map((entry) => {
    const file = diff.files.find((candidate) => candidate.path === entry.path);
    const lines = file && !file.binary && !file.submodule ? linesFromHunks(file.hunks) : [];
    return {
      path: entry.path,
      badge: workingBadge(entry, status.conflicted.includes(entry.path)),
      additions: file?.added_lines ?? null,
      deletions: file?.deleted_lines ?? null,
      notes: [],
      lines,
      emptyNote: file?.binary
        ? 'Binary file — no text hunks.'
        : file?.submodule
          ? 'Submodule change.'
          : 'No textual changes to show.',
      canOpen: entry.worktree_status !== 'deleted' && entry.index_status !== 'deleted',
    };
  });
}

/** The sidebar's changed-file tree: directories are always branches (house
 *  Tree convention), files carry their status badge and diffstat. */
function ReviewTreeNodes({
  nodes,
  entriesByPath,
  openDirs,
  selectedPath,
  onSelect,
}: {
  nodes: ReviewTreeNode[];
  entriesByPath: Map<string, ReviewEntry>;
  openDirs: ReadonlySet<string>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'dir') {
          const open = openDirs.has(node.path);
          return (
            <TreeItem key={`dir:${node.path}`} itemType="branch" title={node.path} value={node.path}>
              <TreeItemLayout
                className="min-h-7 py-0.5 text-xs"
                iconBefore={
                  open ? (
                    <FolderOpen className="size-3.5 shrink-0 text-chart-4" />
                  ) : (
                    <Folder className="size-3.5 shrink-0 text-chart-4" />
                  )
                }
              >
                {node.name}
              </TreeItemLayout>
              {open && (
                <Tree>
                  <ReviewTreeNodes
                    nodes={node.children}
                    entriesByPath={entriesByPath}
                    openDirs={openDirs}
                    selectedPath={selectedPath}
                    onSelect={onSelect}
                  />
                </Tree>
              )}
            </TreeItem>
          );
        }
        const entry = entriesByPath.get(node.path);
        if (!entry) {
          return null;
        }
        const selected = selectedPath === node.path;
        return (
          <TreeItem
            key={`file:${node.path}`}
            itemType="leaf"
            aria-selected={selected}
            className={cn(selected && 'bg-accent')}
            title={node.path}
            value={node.path}
            onClick={() => onSelect(node.path)}
          >
            <TreeItemLayout
              className="min-h-7 gap-1.5 py-0.5 text-xs"
              iconBefore={
                <span
                  className={cn('shrink-0 font-mono font-semibold', entry.badge.className)}
                  title={entry.badge.title}
                >
                  {entry.badge.text}
                </span>
              }
            >
              {node.name}
            </TreeItemLayout>
          </TreeItem>
        );
      })}
    </>
  );
}

function Counts({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions === null && deletions === null) {
    return null;
  }
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-xs">
      {additions !== null && <span className="text-success">+{additions}</span>}{' '}
      {deletions !== null && <span className="text-destructive">−{deletions}</span>}
    </span>
  );
}

function isContentLine(line: ReviewDiffLine): boolean {
  return line.kind === 'add' || line.kind === 'delete' || line.kind === 'context';
}

/**
 * Shiki tokens for a file section's content lines, or null while pending /
 * for unhighlightable files. Content lines (adds, deletes, context) are
 * joined in order and tokenized as one block so multi-line constructs
 * highlight correctly, then mapped back one-to-one by line index.
 */
function useDiffTokens(entry: ReviewEntry, enabled: boolean): ThemedToken[][] | null {
  const language = useMemo(() => languageForPath(entry.path), [entry.path]);
  const code = useMemo(
    () =>
      entry.lines
        .filter(isContentLine)
        .map((line) => line.content)
        .join('\n'),
    [entry.lines]
  );
  const [tokenized, setTokenized] = useState<TokenizedCode | null>(null);
  useEffect(() => {
    if (!enabled || !language || code === '') {
      setTokenized(null);
      return;
    }
    let alive = true;
    const immediate = highlightCode(code, language, (result) => {
      if (alive) {
        setTokenized(result);
      }
    });
    setTokenized(immediate);
    return () => {
      alive = false;
    };
  }, [enabled, language, code]);
  return tokenized?.tokens ?? null;
}

function ReviewDiffLines({ lines, tokens }: { lines: ReviewDiffLine[]; tokens: ThemedToken[][] | null }) {
  // nth content line ↔ nth tokenized line; separators/notes carry no code.
  const tokenIndexByLine = useMemo(() => {
    let next = 0;
    return lines.map((line) => (isContentLine(line) ? next++ : null));
  }, [lines]);
  return (
    <pre className="m-0 font-mono text-xs" aria-label="Diff lines">
      {lines.map((line, index) => {
        const tokenIndex = tokenIndexByLine[index];
        const lineTokens = tokenIndex !== null && tokenIndex !== undefined ? tokens?.[tokenIndex] : undefined;
        return (
          <span
            key={index}
            className={cn(
              'grid grid-cols-[3.5rem_1rem_minmax(max-content,1fr)] whitespace-pre',
              line.kind === 'add' && 'bg-success/10',
              line.kind === 'delete' && 'bg-destructive/10',
              (line.kind === 'separator' || line.kind === 'note') && 'text-muted-foreground'
            )}
          >
            <span className="pr-2 text-right text-muted-foreground" aria-hidden="true">
              {line.newLineno ?? (line.kind === 'separator' ? '⋯' : '')}
            </span>
            <span aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '}</span>
            <span>
              {lineTokens && lineTokens.length > 0
                ? lineTokens.map((token, tokenIdx) => <TokenSpan key={tokenIdx} token={token} />)
                : line.content}
            </span>
          </span>
        );
      })}
    </pre>
  );
}

/** One file in the stream: a sticky, clickable header (chevron, change
 *  badge, path, counts, caveat chips, open-file action) over a
 *  collapsible numbered diff. */
function FileSection({
  entry,
  open,
  onOpenChange,
  onOpenFile,
}: {
  entry: ReviewEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  // Tokenize only while expanded — a collapsed section costs nothing, and
  // the token cache makes re-expanding instant.
  const tokens = useDiffTokens(entry, open);
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="group/file border-b border-border"
      data-review-file={entry.path}
    >
      <div className="sticky top-0 z-10 flex items-center gap-1 bg-card px-2 py-1">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-accent/50"
            aria-label={`${open ? 'Collapse' : 'Expand'} diff for ${entry.path}`}
          >
            <ChevronRightIcon
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/file:rotate-90"
              aria-hidden
            />
            <span
              className={cn('shrink-0 font-mono text-xs font-semibold', entry.badge.className)}
              title={entry.badge.title}
            >
              {entry.badge.text}
            </span>
            <span className="min-w-0 truncate font-mono text-xs font-medium text-foreground" title={entry.path}>
              {entry.path}
            </span>
            <Counts additions={entry.additions} deletions={entry.deletions} />
            {entry.notes.map((note) => (
              <Badge key={note} variant="outline" className="shrink-0 px-1 py-0 text-[10px] font-normal text-warning">
                {note}
              </Badge>
            ))}
          </button>
        </CollapsibleTrigger>
        {onOpenFile && entry.canOpen ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            title={`Open ${entry.path}`}
            aria-label={`Open ${entry.path}`}
            onClick={() => onOpenFile(entry.path, firstAddedLine(entry.lines))}
          >
            <SquareArrowOutUpRightIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <CollapsibleContent>
        {entry.lines.length > 0 ? (
          <ReviewDiffLines lines={entry.lines} tokens={tokens} />
        ) : (
          <p className="px-9 pb-2 text-xs text-muted-foreground">{entry.emptyNote}</p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export const ReviewSurface = memo((props: ReviewSurfaceProps) => {
  const { executionTarget, sessionId, workspaceRoot, active = true, onOpenFile } = props;
  const rpc = useRPCClient();
  const connected = useRPCConnected();
  const gitClient = useMemo(() => new GitClient(rpc, executionTarget), [executionTarget, rpc]);
  const identityKey = sessionId && workspaceRoot ? JSON.stringify([sessionId, executionTarget, workspaceRoot]) : null;
  const readSupported = GIT_READ_OPERATIONS.every((operation) => rpc.supportsExperimentalOperation(operation));

  const runDiffBySession = useStore($runDiffBySession, { keys: sessionId ? [sessionId] : [] });
  const runDiff = sessionId ? runDiffBySession[sessionId] : undefined;

  const [scope, setScope] = useState<ReviewScope>('turn');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(new Set());
  // Directories the user closed in the sidebar tree; everything else is
  // open by default.
  const [closedDirs, setClosedDirs] = useState<ReadonlySet<string>>(new Set());
  const [repositories, setRepositories] = useState<GitListRepositoriesResult | null>(null);
  const [repo, setRepo] = useState<WorkspaceRepo | null>(null);
  const [workingData, setWorkingData] = useState<{ status: GitStatusResult; diff: GitDiffResult } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);

  // Sidebar visibility: explicit toggle wins; before the user chooses, it
  // follows the surface width (hidden in narrow sidecar columns).
  const rootRef = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(true);
  const [sidebarPref, setSidebarPref] = useState<boolean | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver((observations) => {
      const width = observations[0]?.contentRect.width ?? 0;
      setWide(width >= SIDEBAR_AUTO_HIDE_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const sidebarVisible = sidebarPref ?? wide;

  // A new session/workspace identity is a new review: reset scope to the
  // question the user arrives with ("what did the agent just change"),
  // falling back to the working tree when the turn changed nothing. Read
  // imperatively — a run diff landing mid-view must not yank the scope.
  useEffect(() => {
    const current = sessionId ? $runDiffBySession.get()[sessionId] : undefined;
    setScope(current && current.files.length > 0 ? 'turn' : 'working');
    setSelectedPath(null);
    setCollapsedPaths(new Set());
    setClosedDirs(new Set());
    setRepositories(null);
    setRepo(null);
    setWorkingData(null);
    setLoadError(null);
  }, [identityKey, sessionId]);

  // Working-tree scope data: repository discovery once, then status plus
  // the FULL uncommitted diff (HEAD + untracked) — never file-scoped, so a
  // reader keeping the surface open always sees every change.
  useEffect(() => {
    let alive = true;
    if (scope !== 'working' || !active || !connected || !identityKey || !readSupported) {
      return () => {
        alive = false;
      };
    }
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        let repoList = repositories;
        if (!repoList) {
          repoList = await gitClient.listRepositories();
          if (!alive) {
            return;
          }
          setRepositories(repoList);
        }
        const target =
          (repo && repoList.repositories.some((candidate) => candidate.repo === repo) ? repo : null) ??
          repoList.repositories.find((candidate) => candidate.repo === '.')?.repo ??
          repoList.repositories[0]?.repo ??
          null;
        if (target === null) {
          if (alive) {
            setWorkingData(null);
            setLoadError('No Git repositories were found in this workspace.');
          }
          return;
        }
        if (target !== repo && alive) {
          setRepo(target);
        }
        const [status, diff] = await Promise.all([
          gitClient.status(target, { includeUntracked: true }),
          gitClient.diff(target, { mode: 'head', includeUntracked: true }),
        ]);
        if (alive) {
          setWorkingData({ status, diff });
        }
      } catch (error: unknown) {
        if (alive) {
          setWorkingData(null);
          setLoadError(errorMessage(error, 'Could not load working tree changes.'));
        }
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // `repositories`/`repo` are read but deliberately not dependencies:
    // discovery happens once per identity, and `repo` changes re-enter
    // through chooseRepository's state updates below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, active, connected, identityKey, readSupported, gitClient, refreshRevision]);

  const refresh = useCallback(() => setRefreshRevision((revision) => revision + 1), []);
  const chooseScope = useCallback((value: ReviewScope) => {
    setScope(value);
    setSelectedPath(null);
    setCollapsedPaths(new Set());
    setClosedDirs(new Set());
  }, []);
  const chooseRepository = useCallback((value: WorkspaceRepo) => {
    setRepo(value);
    setSelectedPath(null);
    setCollapsedPaths(new Set());
    setClosedDirs(new Set());
    setWorkingData(null);
    setRefreshRevision((revision) => revision + 1);
  }, []);
  const openWorkingFile = useCallback(
    (path: string, line?: number) => {
      if (!onOpenFile) {
        return;
      }
      onOpenFile(repo && repo !== '.' ? `${repo}/${path}` : path, line);
    },
    [onOpenFile, repo]
  );
  const openFile = scope === 'working' ? (onOpenFile ? openWorkingFile : undefined) : onOpenFile;

  // Selecting a file in the sidebar expands its section and scrolls it
  // into view (table-of-contents behavior) — it never filters the stream.
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollToFile = useCallback((path: string) => {
    setSelectedPath(path);
    setCollapsedPaths((prev) => {
      if (!prev.has(path)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    bodyRef.current?.querySelector(`[data-review-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start' });
  }, []);
  const setSectionOpen = useCallback((path: string, open: boolean) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (open) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const entries = useMemo(() => {
    if (scope === 'turn') {
      return runDiff && runDiff.files.length > 0 ? turnEntries(runDiff) : [];
    }
    return workingData ? workingEntries(workingData.status, workingData.diff) : [];
  }, [scope, runDiff, workingData]);

  const tree = useMemo(() => buildFileTree(entries.map((entry) => entry.path)), [entries]);
  const entriesByPath = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries]);
  const openDirs = useMemo(
    () => new Set(treeDirPaths(tree).filter((path) => !closedDirs.has(path))),
    [tree, closedDirs]
  );
  const handleTreeOpenChange = useCallback(({ value, open }: TreeItemOpenChangeData) => {
    if (typeof value !== 'string') {
      return;
    }
    setClosedDirs((prev) => {
      const next = new Set(prev);
      if (open) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  }, []);

  const stats = useMemo(() => {
    if (scope === 'turn') {
      return runDiff ? runDiff.stats : null;
    }
    if (!workingData) {
      return null;
    }
    return {
      filesChanged: entries.length,
      additions: workingData.diff.files.reduce((sum, file) => sum + (file.added_lines ?? 0), 0),
      deletions: workingData.diff.files.reduce((sum, file) => sum + (file.deleted_lines ?? 0), 0),
    };
  }, [scope, runDiff, workingData, entries]);
  const branch = scope === 'working' ? (workingData?.status.head.branch ?? null) : null;

  let body;
  if (!identityKey) {
    body = (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyTitle>Open an agent workspace</EmptyTitle>
          <EmptyDescription>Review is available after a workspace is connected.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (scope === 'turn' && entries.length === 0) {
    body = (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyTitle>No changes this turn</EmptyTitle>
          <EmptyDescription>
            When the agent edits files, its run diff lands here. Switch to Working tree to see everything uncommitted.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (scope === 'working' && !readSupported) {
    body = (
      <Empty className="h-full rounded-none border-0">
        <EmptyHeader>
          <EmptyTitle>Working tree unavailable</EmptyTitle>
          <EmptyDescription>This agent runtime does not support source control reads.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (scope === 'working' && !connected && !workingData) {
    body = (
      <Empty className="h-full rounded-none border-0" role="status">
        <EmptyHeader>
          <EmptyMedia>
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Connecting…</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  } else if (scope === 'working' && loadError && !workingData) {
    body = (
      <Empty className="h-full rounded-none border-0" role="alert">
        <EmptyHeader>
          <EmptyTitle>Working tree unavailable</EmptyTitle>
          <EmptyDescription>{loadError}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (scope === 'working' && !workingData) {
    body = (
      <Empty className="h-full rounded-none border-0" role="status">
        <EmptyHeader>
          <EmptyMedia>
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Loading changes…</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  } else if (entries.length === 0) {
    body = (
      <Empty className="h-full rounded-none border-0" role="status">
        <EmptyHeader>
          <EmptyTitle>Working tree clean</EmptyTitle>
          <EmptyDescription>Everything is committed — changes land here as they happen.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    const truncationNote =
      scope === 'turn' && runDiff && (runDiff.truncated || runDiff.filesTruncated)
        ? runDiff.truncated && runDiff.filesTruncated
          ? 'The textual diff and file list are truncated; some changes are not shown.'
          : runDiff.truncated
            ? 'The textual diff is truncated; some files may be missing content.'
            : 'The file list is truncated; some changed files are not shown.'
        : null;
    body = (
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        {sidebarVisible && (
          <>
            <ResizablePanel id="review-files" defaultSize={240} minSize={160} maxSize={420}>
              <ScrollArea className="h-full">
                <Tree
                  openItems={openDirs}
                  onOpenChange={handleTreeOpenChange}
                  className="p-1.5"
                  aria-label="Changed files"
                >
                  <ReviewTreeNodes
                    nodes={tree}
                    entriesByPath={entriesByPath}
                    openDirs={openDirs}
                    selectedPath={selectedPath}
                    onSelect={scrollToFile}
                  />
                </Tree>
              </ScrollArea>
            </ResizablePanel>
            <ResizableHandle />
          </>
        )}
        <ResizablePanel id="review-diff" minSize={240}>
          <div className="omni-review-diff h-full overflow-auto">
            {truncationNote ? (
              <p className="border-b border-border px-3 py-1.5 text-xs text-warning" role="note">
                {truncationNote}
              </p>
            ) : null}
            {entries.map((entry) => (
              <FileSection
                key={entry.path}
                entry={entry}
                open={!collapsedPaths.has(entry.path)}
                onOpenChange={(open) => setSectionOpen(entry.path, open)}
                onOpenFile={openFile}
              />
            ))}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  return (
    <section
      ref={rootRef}
      className="flex h-full w-full min-w-0 min-h-0 flex-col bg-card text-foreground"
      aria-label="Review"
    >
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        {/* Every control in this bar is h-7 so the bar sits at exactly its
            36px min-height with even vertical breathing room. */}
        <Toggle
          size="sm"
          className="h-7 min-w-7 px-1"
          pressed={sidebarVisible}
          onPressedChange={(pressed) => setSidebarPref(pressed)}
          title={sidebarVisible ? 'Hide file list' : 'Show file list'}
          aria-label={sidebarVisible ? 'Hide file list' : 'Show file list'}
        >
          <PanelLeftIcon className="size-4" />
        </Toggle>
        <Select value={scope} onValueChange={(value) => value && chooseScope(value as ReviewScope)}>
          <SelectTrigger size="sm" className="h-7 gap-1.5 border-0 px-2 text-xs shadow-none" aria-label="Review scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="turn">This turn</SelectItem>
            <SelectItem value="working">Working tree</SelectItem>
          </SelectContent>
        </Select>
        {scope === 'working' && repositories && repositories.repositories.length > 1 && (
          <Select
            value={repo ?? ''}
            onValueChange={(value) => value && chooseRepository(value as WorkspaceRepo)}
            disabled={!connected}
          >
            <SelectTrigger
              size="sm"
              className="h-7 max-w-64 gap-1.5 border-0 px-2 text-xs shadow-none"
              aria-label="Repository"
            >
              <SelectValue placeholder="Repository" />
            </SelectTrigger>
            <SelectContent>
              {repositories.repositories.map((repository) => (
                <SelectItem key={repository.repo} value={repository.repo}>
                  {repositoryLabel(repository)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="flex-auto" />
        {stats ? (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {branch ? `${branch} · ` : ''}
            {stats.filesChanged} {stats.filesChanged === 1 ? 'file' : 'files'}{' '}
            <span className="text-success">+{stats.additions}</span>{' '}
            <span className="text-destructive">−{stats.deletions}</span>
          </span>
        ) : null}
        {scope === 'working' && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            disabled={!connected || loading}
            onClick={refresh}
            title="Refresh"
            aria-label="Refresh review"
          >
            <RefreshCwIcon className={cn('size-4', loading && 'animate-spin')} />
          </Button>
        )}
      </div>
      {scope === 'working' && loadError && workingData && (
        <Alert className="shrink-0 rounded-none border-x-0 border-t-0" variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      <div ref={bodyRef} className="min-h-0 min-w-0 flex-auto overflow-hidden">
        {body}
      </div>
    </section>
  );
});
ReviewSurface.displayName = 'ReviewSurface';

/** Portal rendered inside the column's existing RPC provider — same
 *  pattern as ``WorkspaceGitPortal``. */
export function WorkspaceReviewPortal({ host, ...props }: ReviewSurfaceProps & { host: HTMLDivElement }) {
  return createPortal(<ReviewSurface {...props} />, host);
}
