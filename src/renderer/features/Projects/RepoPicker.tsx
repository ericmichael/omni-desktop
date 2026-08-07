import { Lock } from 'lucide-react';
/**
 * Provider-agnostic repository picker: a scope (owner/org) + debounced search +
 * results, fed by injected `searchRepos`. Scales to large accounts by scoping
 * to one owner/org and searching within it rather than enumerating everything.
 *
 * Two scope modes:
 *   - **Enumerated** (`loadScopes`): a `<Select>` of discovered scopes — GitHub
 *     owners (the user + their orgs).
 *   - **Manual** (`manualScope`): a text input for the scope id — Azure DevOps,
 *     where listing orgs needs broader PAT scopes than repo read, so the user
 *     types their org.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/renderer/ds/cn';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/renderer/ds/ui/command';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect as Select } from '@/renderer/ds/ui/native-select';
import { Spinner } from '@/renderer/ds/ui/spinner';
import type { RemoteRepo } from '@/shared/types';

const SEARCH_DEBOUNCE_MS = 350;

/** A discovery scope (a GitHub owner, an Azure org). `kind` is GitHub-only. */
export type RepoScope = { id: string; label: string; kind?: 'user' | 'org' };

type RepoPickerProps = {
  /** When true the picker is visible and (re)loads scopes. */
  active: boolean;
  /** Enumerated scopes (GitHub). Omit when using `manualScope`. */
  loadScopes?: () => Promise<RepoScope[]>;
  /** Manual scope entry (Azure org): the user types the scope id. */
  manualScope?: { placeholder: string };
  searchRepos: (scope: RepoScope, query: string) => Promise<RemoteRepo[]>;
  onSelect: (repo: RemoteRepo) => void;
  /** Message when a scope returns no repos. Defaults to a generic line. */
  emptyHint?: (scope: RepoScope | undefined) => string;
};

export const RepoPicker = memo(
  ({ active, loadScopes, manualScope, searchRepos, onSelect, emptyHint }: RepoPickerProps) => {
    const [scopes, setScopes] = useState<RepoScope[] | null>(null);
    const [scopeId, setScopeId] = useState('');
    const [manualScopeId, setManualScopeId] = useState('');
    const [query, setQuery] = useState('');
    const [repos, setRepos] = useState<RemoteRepo[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Monotonic id so a slow earlier search can't overwrite a newer one.
    const reqSeq = useRef(0);

    const isManual = Boolean(manualScope);
    // Primitive scope key so effects don't churn on a freshly-built scope object.
    const scopeKey = isManual ? manualScopeId.trim() : scopeId;
    const selectedScope: RepoScope | undefined = isManual
      ? scopeKey
        ? { id: scopeKey, label: scopeKey }
        : undefined
      : scopes?.find((s) => s.id === scopeKey);

    // Enumerated mode: load scopes when shown; default to the first.
    useEffect(() => {
      if (!active || isManual || !loadScopes) {
        return;
      }
      setScopes(null);
      setQuery('');
      setRepos(null);
      setError(null);
      let cancelled = false;
      loadScopes()
        .then((list) => {
          if (!cancelled) {
            setScopes(list);
            setScopeId(list[0]?.id ?? '');
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : 'Failed to load account');
          }
        });
      return () => {
        cancelled = true;
      };
    }, [active, isManual, loadScopes]);

    // Reset manual entry each time the picker is shown.
    useEffect(() => {
      if (active && isManual) {
        setManualScopeId('');
        setQuery('');
        setRepos(null);
        setError(null);
      }
    }, [active, isManual]);

    // Debounced, scope-scoped search. Re-runs on scope/query change. Keyed on
    // the primitive scopeKey (not the scope object) so it doesn't loop.
    useEffect(() => {
      if (!active || !scopeKey) {
        return;
      }
      const scope: RepoScope | undefined = isManual
        ? { id: scopeKey, label: scopeKey }
        : scopes?.find((s) => s.id === scopeKey);
      if (!scope) {
        return;
      }
      const seq = ++reqSeq.current;
      setLoading(true);
      setError(null);
      const timer = setTimeout(() => {
        searchRepos(scope, query)
          .then((list) => {
            if (seq === reqSeq.current) {
              setRepos(list);
              setLoading(false);
            }
          })
          .catch((e: unknown) => {
            if (seq === reqSeq.current) {
              setError(e instanceof Error ? e.message : 'Search failed');
              setLoading(false);
            }
          });
      }, SEARCH_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }, [active, isManual, scopeKey, query, searchRepos, scopes]);

    const handleScopeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
      setScopeId(e.target.value);
    }, []);
    const handleManualScopeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setManualScopeId(e.target.value);
    }, []);
    const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
    }, []);

    // Enumerated mode still loading its scopes.
    const loadingScopes = !manualScope && !scopes;

    return (
      <div className="flex flex-col gap-2 min-h-72">
        <div className="flex gap-2">
          {manualScope ? (
            <Input
              className="basis-2/5 shrink-0 grow-0"
              type="text"
              value={manualScopeId}
              onChange={handleManualScopeChange}
              placeholder={manualScope.placeholder}
            />
          ) : (
            <Select
              className="basis-2/5 shrink-0 grow-0"
              value={scopeId}
              onChange={handleScopeChange}
              aria-label="Owner"
            >
              {(scopes ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
          <Input
            className="flex-1"
            type="text"
            value={query}
            onChange={handleQueryChange}
            placeholder="Search repositories…"
          />
        </div>

        {error ? (
          <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>{error}</span>
        ) : manualScope && !selectedScope ? (
          <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground p-2')}>
            Enter your {manualScope.placeholder.toLowerCase()} to list repositories.
          </span>
        ) : loadingScopes || (loading && !repos) ? (
          <div className="flex items-center justify-center gap-2 p-5">
            <Spinner />
            <span className="text-xs text-muted-foreground">{loadingScopes ? 'Loading account…' : 'Searching…'}</span>
          </div>
        ) : (
          <Command shouldFilter={false} className="bg-transparent">
            {/* A real viewport-relative cap: the percentage `max-h-2/5` this
                replaced resolved against an auto-height parent, so browsers
                ignored it and long repo lists grew past the dialog. */}
            <CommandList className="max-h-[40vh]">
              <CommandEmpty>{emptyHint?.(selectedScope) ?? 'No repositories found.'}</CommandEmpty>
              <CommandGroup>
                {(repos ?? []).map((repo) => (
                  <RepoRow key={repo.fullName} repo={repo} onSelect={onSelect} />
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </div>
    );
  }
);
RepoPicker.displayName = 'RepoPicker';

type RepoRowProps = {
  repo: RemoteRepo;
  onSelect: (repo: RemoteRepo) => void;
};

const RepoRow = memo(({ repo, onSelect }: RepoRowProps) => {
  const handleClick = useCallback(() => onSelect(repo), [repo, onSelect]);
  return (
    <CommandItem value={repo.fullName} onSelect={handleClick}>
      {repo.private && <Lock className="text-muted-foreground shrink-0" />}
      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{repo.fullName}</span>
      <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground shrink-0')}>
        {repo.defaultBranch}
      </span>
    </CommandItem>
  );
});
RepoRow.displayName = 'RepoRow';
