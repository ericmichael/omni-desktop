import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  GitClient,
  GitConfirmation,
  GitFileSelection,
  GitMutationOutcome,
  GitResetMode,
  GitSelection,
  WorkspaceRepo,
} from '@/renderer/omniagents-ui/rpc/git';

/**
 * One mutation pipeline for the whole Git app: every write (stage, commit,
 * checkout, push, …) funnels through a single busy/error/notice state and a
 * single server-confirmation slot, so the commit box, the diff stream's
 * stage buttons, and the tools panel all agree on what is in flight and the
 * surface renders exactly one confirmation dialog.
 */

export type GitCommitOptions = { amend?: boolean };
export type GitCheckoutOptions = { create?: boolean; startPoint?: string };
export type GitResetOptions = { mode?: GitResetMode; rev?: string };
export type GitPushOptions = { forceWithLease?: boolean; setUpstream?: boolean };

type PendingGitIntent =
  | { kind: 'commit'; message: string; options: GitCommitOptions }
  | { kind: 'checkout'; branch: string; options: GitCheckoutOptions }
  | { kind: 'reset'; options: GitResetOptions }
  | { kind: 'push'; options: GitPushOptions }
  | { kind: 'discard'; selection: GitFileSelection };

export type PendingGitConfirmation = PendingGitIntent & { confirmation: GitConfirmation };

export type GitMutations = {
  /** Label of the operation in flight, or null when idle. */
  busy: string | null;
  error: string | null;
  notice: string | null;
  /** Latest fetch/pull/push progress line from the server. */
  progress: string | null;
  pending: PendingGitConfirmation | null;
  stage: (selection: GitSelection) => Promise<void>;
  unstage: (selection: GitFileSelection) => Promise<void>;
  discard: (selection: GitFileSelection) => Promise<void>;
  /** Resolves true when the commit completed (message box can clear). */
  commit: (message: string, options: GitCommitOptions) => Promise<boolean>;
  checkout: (branch: string, options?: GitCheckoutOptions) => Promise<void>;
  reset: (options: GitResetOptions) => Promise<void>;
  fetchRemote: () => Promise<void>;
  pull: (options: { rebase: boolean }) => Promise<void>;
  push: (options: GitPushOptions) => Promise<void>;
  /** Stage a conflicted path to mark it resolved. */
  markResolved: (path: string) => Promise<void>;
  /** Redeem the pending server confirmation. */
  confirm: () => void;
  dismissPending: () => void;
};

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sentence(text: string): string {
  const spaced = text.replaceAll('_', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Human copy for the single confirmation dialog. */
export function describeConfirmation(pending: PendingGitConfirmation): {
  title: string;
  body: string;
  action: string;
  destructive: boolean;
} {
  const impact = Object.entries(pending.confirmation.impact)
    .map(([key, value]) => `${sentence(key)}: ${Array.isArray(value) ? value.join(', ') : String(value)}.`)
    .join(' ');
  switch (pending.kind) {
    case 'discard':
      return {
        title: 'Discard selected changes?',
        body: `Discarding changes cannot be undone. ${impact}`.trim(),
        action: 'Discard changes',
        destructive: true,
      };
    case 'commit':
      return {
        title: 'Confirm commit?',
        body: `The server asks for confirmation before committing. ${impact}`.trim(),
        action: pending.options.amend ? 'Amend commit' : 'Commit',
        destructive: false,
      };
    case 'checkout':
      return {
        title: `Check out ${pending.branch}?`,
        body: `The server asks for confirmation before switching branches. ${impact}`.trim(),
        action: 'Checkout',
        destructive: false,
      };
    case 'reset':
      return {
        title: 'Reset repository?',
        body: `${pending.options.mode === 'hard' ? 'A hard reset permanently discards local work. ' : ''}${impact}`.trim(),
        action: 'Reset',
        destructive: pending.options.mode === 'hard',
      };
    case 'push':
      return {
        title: 'Confirm push?',
        body: `${pending.options.forceWithLease ? 'This push rewrites the remote branch. ' : ''}${impact}`.trim(),
        action: 'Push',
        destructive: pending.options.forceWithLease === true,
      };
  }
}

export function useGitMutations({
  client,
  repo,
  subscribeProgress,
  onChanged,
}: {
  client: GitClient;
  repo: WorkspaceRepo | null;
  subscribeProgress: boolean;
  onChanged: () => void;
}): GitMutations {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingGitConfirmation | null>(null);
  // Callbacks close over the repo they were invoked for; a repo switch must
  // not let a stale async completion mutate feedback for the new repo.
  const repoRef = useRef(repo);
  useEffect(() => {
    repoRef.current = repo;
    setPending(null);
    setError(null);
    setNotice(null);
  }, [repo]);

  useEffect(() => {
    if (!subscribeProgress || !repo) {
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
  }, [client, repo, subscribeProgress]);

  const run = useCallback(
    async <T>(label: string, operation: (repo: WorkspaceRepo) => Promise<T>): Promise<T | undefined> => {
      const target = repoRef.current;
      if (!target) {
        return undefined;
      }
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        return await operation(target);
      } catch (caught) {
        if (repoRef.current === target) {
          setError(message(caught, `${label} failed.`));
        }
        return undefined;
      } finally {
        setBusy((current) => (current === label ? null : current));
      }
    },
    []
  );

  const completed = useCallback(
    (noticeText: string | null) => {
      setPending(null);
      setNotice(noticeText);
      onChanged();
    },
    [onChanged]
  );

  const handleOutcome = useCallback(
    <T>(outcome: GitMutationOutcome<T>, intent: PendingGitIntent, noticeText: string | null): boolean => {
      if (outcome.kind === 'confirmation_required') {
        setPending({ ...intent, confirmation: outcome.confirmation });
        return false;
      }
      completed(noticeText);
      return true;
    },
    [completed]
  );

  const finishPush = useCallback(
    (outcome: GitMutationOutcome<{ ok: boolean; rejected: string[] }>, options: GitPushOptions) => {
      if (outcome.kind === 'confirmation_required') {
        setPending({ kind: 'push', options, confirmation: outcome.confirmation });
      } else if (outcome.result.ok) {
        completed('Push completed.');
      } else {
        setPending(null);
        setError(
          outcome.result.rejected.length > 0
            ? `Push rejected: ${outcome.result.rejected.join(', ')}`
            : 'Push did not complete.'
        );
        onChanged();
      }
    },
    [completed, onChanged]
  );

  const stage = useCallback(
    async (selection: GitSelection) => {
      await run('Staging', async (target) => {
        await client.stage(target, selection);
        completed(null);
      });
    },
    [client, completed, run]
  );

  const unstage = useCallback(
    async (selection: GitFileSelection) => {
      await run('Unstaging', async (target) => {
        await client.unstage(target, selection);
        completed(null);
      });
    },
    [client, completed, run]
  );

  const discard = useCallback(
    async (selection: GitFileSelection) => {
      await run('Preparing discard', async (target) => {
        handleOutcome(await client.discard(target, selection), { kind: 'discard', selection }, null);
      });
    },
    [client, handleOutcome, run]
  );

  const commit = useCallback(
    async (text: string, options: GitCommitOptions): Promise<boolean> => {
      const result = await run('Committing', async (target) => {
        const outcome = await client.commit(target, text, options);
        return handleOutcome(
          outcome,
          { kind: 'commit', message: text, options },
          options.amend ? 'Commit amended.' : 'Changes committed.'
        );
      });
      return result === true;
    },
    [client, handleOutcome, run]
  );

  const checkout = useCallback(
    async (branch: string, options: GitCheckoutOptions = {}) => {
      await run('Checking out branch', async (target) => {
        handleOutcome(
          await client.checkout(target, branch, options),
          { kind: 'checkout', branch, options },
          `Checked out ${branch}.`
        );
      });
    },
    [client, handleOutcome, run]
  );

  const reset = useCallback(
    async (options: GitResetOptions) => {
      await run('Resetting repository', async (target) => {
        handleOutcome(
          await client.reset(target, options),
          { kind: 'reset', options },
          `Repository reset (${options.mode ?? 'mixed'}).`
        );
      });
    },
    [client, handleOutcome, run]
  );

  const fetchRemote = useCallback(async () => {
    await run('Fetching', async (target) => {
      const result = await client.fetch(target);
      completed(`Fetched ${result.updated_refs.length} ref update${result.updated_refs.length === 1 ? '' : 's'}.`);
    });
  }, [client, completed, run]);

  const pull = useCallback(
    async (options: { rebase: boolean }) => {
      await run('Pulling', async (target) => {
        const result = await client.pull(target, { rebase: options.rebase });
        if (result.conflicted.length) {
          completed(`Pull has ${result.conflicted.length} conflict${result.conflicted.length === 1 ? '' : 's'}.`);
        } else if (result.ok) {
          completed('Pull completed.');
        } else {
          setError('Pull did not complete.');
          onChanged();
        }
      });
    },
    [client, completed, onChanged, run]
  );

  const push = useCallback(
    async (options: GitPushOptions) => {
      await run('Pushing', async (target) => {
        finishPush(await client.push(target, options), options);
      });
    },
    [client, finishPush, run]
  );

  const markResolved = useCallback(
    async (path: string) => {
      await run('Marking conflict resolved', async (target) => {
        await client.stage(target, { paths: [path] });
        completed(`Marked ${path} resolved.`);
      });
    },
    [client, completed, run]
  );

  const confirm = useCallback(() => {
    const current = pending;
    if (!current) {
      return;
    }
    void run('Confirming Git operation', async (target) => {
      // Close the dialog up front: an error must surface in the alert strip,
      // not behind a stale dialog. A chained confirmation re-opens it.
      setPending(null);
      if (current.kind === 'discard') {
        handleOutcome(await client.confirmDiscard(target, current.selection, current.confirmation), current, null);
      } else if (current.kind === 'commit') {
        handleOutcome(
          await client.confirmCommit(target, current.message, current.options, current.confirmation),
          current,
          current.options.amend ? 'Commit amended.' : 'Changes committed.'
        );
      } else if (current.kind === 'checkout') {
        handleOutcome(
          await client.confirmCheckout(target, current.branch, current.options, current.confirmation),
          current,
          `Checked out ${current.branch}.`
        );
      } else if (current.kind === 'reset') {
        handleOutcome(
          await client.confirmReset(target, current.options, current.confirmation),
          current,
          `Repository reset (${current.options.mode ?? 'mixed'}).`
        );
      } else {
        finishPush(await client.confirmPush(target, current.options, current.confirmation), current.options);
      }
    });
  }, [client, finishPush, handleOutcome, pending, run]);

  const dismissPending = useCallback(() => setPending(null), []);

  return useMemo(
    () => ({
      busy,
      error,
      notice,
      progress,
      pending,
      stage,
      unstage,
      discard,
      commit,
      checkout,
      reset,
      fetchRemote,
      pull,
      push,
      markResolved,
      confirm,
      dismissPending,
    }),
    [
      busy,
      error,
      notice,
      progress,
      pending,
      stage,
      unstage,
      discard,
      commit,
      checkout,
      reset,
      fetchRemote,
      pull,
      push,
      markResolved,
      confirm,
      dismissPending,
    ]
  );
}
