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
import { makeStyles, tokens } from '@fluentui/react-components';
import { LockClosed16Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Caption1, Input, Select, Spinner } from '@/renderer/ds';
import type { RemoteRepo } from '@/shared/types';

const SEARCH_DEBOUNCE_MS = 350;

/** A discovery scope (a GitHub owner, an Azure org). `kind` is GitHub-only. */
export type RepoScope = { id: string; label: string; kind?: 'user' | 'org' };

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minHeight: '300px' },
  controls: { display: 'flex', gap: tokens.spacingHorizontalS },
  scope: { flex: '0 0 40%' },
  search: { flex: '1 1 0' },
  list: { display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto', maxHeight: '42vh' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    textAlign: 'left',
    backgroundColor: 'transparent',
    border: 'none',
    width: '100%',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  itemName: { flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemMeta: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  center: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalL,
  },
  hint: { color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalS },
  error: { color: tokens.colorPaletteRedForeground1 },
  privateIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
});

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
    const styles = useStyles();
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
      <div className={styles.root}>
        <div className={styles.controls}>
          {manualScope ? (
            <Input
              className={styles.scope}
              type="text"
              value={manualScopeId}
              onChange={handleManualScopeChange}
              placeholder={manualScope.placeholder}
            />
          ) : (
            <Select className={styles.scope} value={scopeId} onChange={handleScopeChange} aria-label="Owner">
              {(scopes ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
          <Input
            className={styles.search}
            type="text"
            value={query}
            onChange={handleQueryChange}
            placeholder="Search repositories…"
          />
        </div>

        {error ? (
          <Caption1 className={styles.error}>{error}</Caption1>
        ) : manualScope && !selectedScope ? (
          <Caption1 className={styles.hint}>
            Enter your {manualScope.placeholder.toLowerCase()} to list repositories.
          </Caption1>
        ) : loadingScopes || (loading && !repos) ? (
          <div className={styles.center}>
            <Spinner size="sm" />
            <Caption1>{loadingScopes ? 'Loading account…' : 'Searching…'}</Caption1>
          </div>
        ) : (
          <div className={styles.list}>
            {(repos ?? []).map((repo) => (
              <RepoRow key={repo.fullName} repo={repo} styles={styles} onSelect={onSelect} />
            ))}
            {repos && repos.length === 0 && (
              <Caption1 className={styles.hint}>{emptyHint?.(selectedScope) ?? 'No repositories found.'}</Caption1>
            )}
          </div>
        )}
      </div>
    );
  }
);
RepoPicker.displayName = 'RepoPicker';

type RepoRowProps = {
  repo: RemoteRepo;
  styles: ReturnType<typeof useStyles>;
  onSelect: (repo: RemoteRepo) => void;
};

const RepoRow = memo(({ repo, styles, onSelect }: RepoRowProps) => {
  const handleClick = useCallback(() => onSelect(repo), [repo, onSelect]);
  return (
    <button type="button" className={styles.item} onClick={handleClick}>
      {repo.private && <LockClosed16Regular className={styles.privateIcon} />}
      <span className={styles.itemName}>{repo.fullName}</span>
      <Caption1 className={styles.itemMeta}>{repo.defaultBranch}</Caption1>
    </button>
  );
});
RepoRow.displayName = 'RepoRow';
