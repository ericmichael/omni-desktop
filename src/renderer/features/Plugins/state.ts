import { useCallback, useEffect, useState } from 'react';

import { agentConfigApi } from '@/renderer/services/config';
import { emitter } from '@/renderer/services/ipc';
import type { ExtensionDescriptor } from '@/shared/extensions';
import type { BundleUpdateInfo, MarketplaceManifest, McpConfig, SkillEntry } from '@/shared/types';

export type PluginsData = {
  loading: boolean;
  error: string | null;
  skills: SkillEntry[];
  updates: Record<string, BundleUpdateInfo>;
  extensions: ExtensionDescriptor[];
  mcpConfig: McpConfig | null;
  /** Reload everything; used as the post-mutation callback. */
  refresh: () => Promise<void>;
};

/**
 * Loads the installed side of the Plugins tab (skills + bundle updates,
 * extensions, MCP config). Sources fail independently — one unreachable
 * backend surfaces as the error banner without blanking the others.
 * Custom apps come reactively from the persisted store, not from here.
 */
export function usePluginsData(): PluginsData {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [updates, setUpdates] = useState<Record<string, BundleUpdateInfo>>({});
  const [extensions, setExtensions] = useState<ExtensionDescriptor[]>([]);
  const [mcpConfig, setMcpConfig] = useState<McpConfig | null>(null);

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      emitter.invoke('skills:list').then(setSkills),
      emitter.invoke('extension:list-descriptors').then(setExtensions),
      agentConfigApi.getMcp().then(setMcpConfig),
    ]);
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    setError(failure ? (failure.reason instanceof Error ? failure.reason.message : 'Failed to load plugins') : null);
    setLoading(false);

    // Update probing hits the network per installed bundle — fire it after
    // the page is interactive, and let failures fall back to the per-bundle
    // "unreachable" state rather than the banner.
    try {
      const reports = await emitter.invoke('skills:check-bundle-updates');
      setUpdates(Object.fromEntries(reports.map((r) => [r.bundleKey, r])));
    } catch {
      // Network failures shouldn't block the tab.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { loading, error, skills, updates, extensions, mcpConfig, refresh };
}

export type FeaturedManifestState = {
  repo: string;
  /** null while loading (and after failure — check `failed`). */
  manifest: MarketplaceManifest | null;
  failed: boolean;
};

/**
 * Fetches every featured marketplace's manifest once, at page level, so
 * drift detection (and "Update all") can see all catalogs, not just the
 * section rendering them. `repos` must be referentially stable.
 */
export function useFeaturedManifests(repos: string[]): FeaturedManifestState[] {
  const [states, setStates] = useState<FeaturedManifestState[]>(() =>
    repos.map((repo) => ({ repo, manifest: null, failed: false }))
  );

  useEffect(() => {
    let cancelled = false;
    setStates(repos.map((repo) => ({ repo, manifest: null, failed: false })));
    for (const repo of repos) {
      emitter
        .invoke('skills:fetch-marketplace', repo)
        .then((manifest) => {
          if (!cancelled) {
            setStates((prev) => prev.map((s) => (s.repo === repo ? { ...s, manifest } : s)));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setStates((prev) => prev.map((s) => (s.repo === repo ? { ...s, failed: true } : s)));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [repos]);

  return states;
}
