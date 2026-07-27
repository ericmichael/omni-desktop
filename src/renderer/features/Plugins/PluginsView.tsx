import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Add20Regular, ArrowDownload20Regular, Globe20Regular, PlugConnected20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { openMobileNav } from '@/renderer/app/mobile-nav';
import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import { Button, FormSkeleton, Input, PageHeader, SectionLabel, SegmentedControl } from '@/renderer/ds';
import { AppFormDialog } from '@/renderer/features/Plugins/AppFormDialog';
import { ConnectorConfigDialog } from '@/renderer/features/Plugins/ConnectorConfigDialog';
import { ExploreSection, FEATURED_MARKETPLACES, installKeyOf } from '@/renderer/features/Plugins/ExploreSection';
import { InstalledSection } from '@/renderer/features/Plugins/InstalledSection';
import { MarketplaceDialog } from '@/renderer/features/Plugins/MarketplaceDialog';
import type { ExplorePlugin, PluginKind } from '@/renderer/features/Plugins/plugin-cards';
import {
  buildExplorePlugins,
  buildInstalledPlugins,
  collectDriftedItems,
  filterPlugins,
  mergeConnectorUpdate,
} from '@/renderer/features/Plugins/plugin-cards';
import { $pluginsInitialFilter } from '@/renderer/features/Plugins/plugins-nav';
import { useFeaturedManifests, usePluginsData } from '@/renderer/features/Plugins/state';
import { agentConfigApi } from '@/renderer/services/config';
import { emitter, isElectron } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import { $glassEnabled } from '@/renderer/theme/use-glass';
import type { CustomAppEntry } from '@/shared/app-registry';
import type { BundleUpdateInfo, MarketplaceApp, McpServerEntry } from '@/shared/types';

const SKILL_FILE_FILTERS = [{ name: 'Skill packages', extensions: ['skill'] }];

/** Referentially stable — useFeaturedManifests keys its fetch effect on this. */
const FEATURED_REPOS = FEATURED_MARKETPLACES.map((m) => m.repo);

const FILTER_OPTIONS: { value: PluginKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'connector', label: 'Connectors' },
  { value: 'skill', label: 'Skills' },
  { value: 'app', label: 'Apps' },
  { value: 'extension', label: 'Extensions' },
];

const useStyles = makeStyles({
  root: {
    height: '100%',
    minHeight: 0,
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  rootGlass: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  inner: {
    maxWidth: '960px',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingBottom: tokens.spacingVerticalXXL,
  },
  search: { width: '220px', maxWidth: '50vw' },
  errorBanner: {
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  addSection: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  addRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  iconMr: { marginRight: tokens.spacingHorizontalXS },
});

function installMarketplaceApp(app: MarketplaceApp): void {
  const current = persistedStoreApi.$atom.get().customApps ?? [];
  if (current.some((a) => a.url === app.url)) {
    return;
  }
  const maxOrder = current.reduce((max, a) => Math.max(max, a.order), 40);
  const entry: CustomAppEntry = {
    id: app.id,
    label: app.label,
    icon: app.icon,
    url: app.url,
    order: maxOrder + 10,
    columnScoped: app.columnScoped ?? false,
  };
  void persistedStoreApi.setKey('customApps', [...current, entry]);
}

/** Pull upstream label/icon onto the installed app; id, order, and the user's dock preference stay. */
function updateMarketplaceAppEntry(app: MarketplaceApp): void {
  const current = persistedStoreApi.$atom.get().customApps ?? [];
  void persistedStoreApi.setKey(
    'customApps',
    current.map((a) => (a.url === app.url ? { ...a, label: app.label, icon: app.icon } : a))
  );
}

export const PluginsView = memo(() => {
  const styles = useStyles();
  const data = usePluginsData();
  const isDesktop = useIsDesktop();
  const isGlass = useStore($glassEnabled);
  const store = useStore(persistedStoreApi.$atom);
  const storeCustomApps = store.customApps;
  const customApps = useMemo(() => storeCustomApps ?? [], [storeCustomApps]);

  const [filter, setFilter] = useState<PluginKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [appFormOpen, setAppFormOpen] = useState(false);
  /** `serverId: null` = create-new (name editable in the dialog). */
  const [connectorDialog, setConnectorDialog] = useState<{ serverId: string | null } | null>(null);

  // Deep link (openPlugins('connector') etc.): consume the one-shot filter
  // and clear it. The page never unmounts, hence the atom.
  const initialFilter = useStore($pluginsInitialFilter);
  useEffect(() => {
    if (initialFilter) {
      setFilter(initialFilter);
      $pluginsInitialFilter.set(null);
    }
  }, [initialFilter]);

  const { refresh } = data;

  const installed = useMemo(
    () =>
      buildInstalledPlugins({
        mcpConfig: data.mcpConfig,
        skills: data.skills,
        updates: data.updates,
        customApps,
        extensions: data.extensions,
      }),
    [data.mcpConfig, data.skills, data.updates, customApps, data.extensions]
  );
  const filteredInstalled = useMemo(() => filterPlugins(installed, filter, query), [installed, filter, query]);

  const ctx = useMemo(
    () => ({ mcpConfig: data.mcpConfig, skills: data.skills, updates: data.updates, customApps }),
    [data.mcpConfig, data.skills, data.updates, customApps]
  );

  const manifests = useFeaturedManifests(FEATURED_REPOS);

  /** Every featured catalog's items with installed/drift state — page-level so "Update all" sees them. */
  const exploreItems = useMemo(
    () => manifests.flatMap((m) => (m.manifest ? buildExplorePlugins(m.repo, m.manifest, ctx) : [])),
    [manifests, ctx]
  );
  const driftedItems = useMemo(() => collectDriftedItems(exploreItems), [exploreItems]);

  /** Replace-one-entry write; reads fresh config so concurrent edits aren't clobbered. */
  const saveConnector = useCallback(
    async (id: string, entry: McpServerEntry) => {
      const config = await agentConfigApi.getMcp();
      await agentConfigApi.setMcp({ ...config, mcpServers: { ...config.mcpServers, [id]: entry } });
      await refresh();
    },
    [refresh]
  );

  const removeConnector = useCallback(async (id: string) => {
    const config = await agentConfigApi.getMcp();
    const { [id]: _, ...rest } = config.mcpServers;
    await agentConfigApi.setMcp({ ...config, mcpServers: rest });
  }, []);

  const handleInstall = useCallback(
    async (item: ExplorePlugin, mode: 'install' | 'update') => {
      setActionError(null);
      setInstallingKey(installKeyOf(item));
      try {
        if (item.kind === 'connector') {
          if (mode === 'update') {
            // Take the upstream transport config but keep the env/header
            // values the user filled in (API keys, tokens).
            const config = await agentConfigApi.getMcp();
            const existing = config.mcpServers[item.connector.id];
            const merged = existing ? mergeConnectorUpdate(existing, item.connector.server) : item.connector.server;
            await agentConfigApi.setMcp({
              ...config,
              mcpServers: { ...config.mcpServers, [item.connector.id]: merged },
            });
            await refresh();
          } else {
            await saveConnector(item.connector.id, item.connector.server);
          }
        } else if (item.kind === 'skill') {
          const channel = mode === 'update' ? 'skills:update-marketplace-plugin' : 'skills:install-marketplace-plugin';
          await emitter.invoke(channel, item.repo, item.plugin.name);
          await refresh();
        } else if (mode === 'update') {
          updateMarketplaceAppEntry(item.app);
        } else {
          installMarketplaceApp(item.app);
        }
      } catch (e) {
        setActionError(e instanceof Error ? e.message : `Failed to ${mode} plugin`);
      } finally {
        setInstallingKey(null);
      }
    },
    [saveConnector, refresh]
  );

  /** Installed bundles with an upstream update, one entry per bundle. */
  const pendingUpdates = useMemo(
    () => Object.values(data.updates).filter((u) => u.status === 'update-available'),
    [data.updates]
  );

  const handleUpdateAll = useCallback(async () => {
    setActionError(null);
    setInstallingKey('update-all');
    try {
      for (const u of pendingUpdates) {
        await emitter.invoke('skills:update-marketplace-plugin', u.repo, u.plugin);
      }

      // Drifted connectors: merge every update into one McpConfig write.
      const connectors = driftedItems.filter((p) => p.kind === 'connector');
      if (connectors.length > 0) {
        const config = await agentConfigApi.getMcp();
        const servers = { ...config.mcpServers };
        for (const c of connectors) {
          const existing = servers[c.connector.id];
          servers[c.connector.id] = existing ? mergeConnectorUpdate(existing, c.connector.server) : c.connector.server;
        }
        await agentConfigApi.setMcp({ ...config, mcpServers: servers });
      }

      // Drifted apps: patch label/icon in one store write.
      const appDefs = driftedItems.flatMap((p) => (p.kind === 'app' ? [p.app] : []));
      if (appDefs.length > 0) {
        const byUrl = new Map(appDefs.map((a) => [a.url, a]));
        const current = persistedStoreApi.$atom.get().customApps ?? [];
        void persistedStoreApi.setKey(
          'customApps',
          current.map((a) => {
            const def = byUrl.get(a.url);
            return def ? { ...a, label: def.label, icon: def.icon } : a;
          })
        );
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to update plugins');
    } finally {
      setInstallingKey(null);
      await refresh();
    }
  }, [pendingUpdates, driftedItems, refresh]);

  const handleUpdateBundle = useCallback(
    async (update: BundleUpdateInfo) => {
      setActionError(null);
      setInstallingKey(`skill:${update.repo}:${update.plugin}`);
      try {
        await emitter.invoke('skills:update-marketplace-plugin', update.repo, update.plugin);
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : 'Failed to update plugin');
      } finally {
        setInstallingKey(null);
      }
    },
    [refresh]
  );

  const installFromFile = useCallback(async () => {
    setActionError(null);
    const filePath = await emitter.invoke('util:select-file', undefined, SKILL_FILE_FILTERS);
    if (!filePath) {
      return;
    }
    try {
      await emitter.invoke('skills:install', filePath);
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to install skill');
    }
  }, [refresh]);

  const error = actionError ?? data.error;
  const existingServerIds = Object.keys(data.mcpConfig?.mcpServers ?? {});
  const editedServer =
    connectorDialog?.serverId != null ? (data.mcpConfig?.mcpServers[connectorDialog.serverId] ?? null) : null;

  return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
      <PageHeader
        title="Plugins"
        onMenu={isDesktop ? undefined : openMobileNav}
        actions={
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins"
            aria-label="Search plugins"
            className={styles.search}
          />
        }
      />
      <div className={styles.inner}>
        <SegmentedControl value={filter} options={FILTER_OPTIONS} onChange={setFilter} />

        {error && <div className={styles.errorBanner}>{error}</div>}

        {data.loading ? (
          <FormSkeleton fields={4} />
        ) : (
          <>
            <InstalledSection
              items={filteredInstalled}
              onRefresh={refresh}
              onError={setActionError}
              onConfigureConnector={(id) => setConnectorDialog({ serverId: id })}
              onRemoveConnector={removeConnector}
              onUpdateBundle={handleUpdateBundle}
              installingKey={installingKey}
              updateAllCount={pendingUpdates.length + driftedItems.length}
              onUpdateAll={handleUpdateAll}
            />

            {FEATURED_MARKETPLACES.map((marketplace, i) => (
              <ExploreSection
                key={marketplace.repo}
                marketplace={marketplace}
                manifest={manifests[i]?.manifest ?? null}
                failed={manifests[i]?.failed ?? false}
                filter={filter}
                query={query}
                ctx={ctx}
                installingKey={installingKey}
                onInstall={handleInstall}
              />
            ))}

            <div className={styles.addSection}>
              <SectionLabel>Add your own</SectionLabel>
              <div className={styles.addRow}>
                <Button size="sm" variant="ghost" onClick={() => setAppFormOpen(true)}>
                  <Add20Regular className={styles.iconMr} />
                  Add custom app
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConnectorDialog({ serverId: null })}>
                  <PlugConnected20Regular className={styles.iconMr} />
                  Add MCP server
                </Button>
                {/* Local-file picker is desktop-only — the server has no client filesystem. */}
                {isElectron && (
                  <Button size="sm" variant="ghost" onClick={installFromFile}>
                    <ArrowDownload20Regular className={styles.iconMr} />
                    Install skill from file
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setMarketplaceOpen(true)}>
                  <Globe20Regular className={styles.iconMr} />
                  Browse a marketplace
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <AppFormDialog open={appFormOpen} onClose={() => setAppFormOpen(false)} />
      <ConnectorConfigDialog
        open={connectorDialog !== null}
        serverId={connectorDialog?.serverId ?? null}
        initial={editedServer}
        existingIds={existingServerIds}
        onSave={saveConnector}
        onClose={() => setConnectorDialog(null)}
      />
      <MarketplaceDialog
        open={marketplaceOpen}
        onClose={() => setMarketplaceOpen(false)}
        ctx={ctx}
        installingKey={installingKey}
        onInstall={handleInstall}
      />
    </div>
  );
});
PluginsView.displayName = 'PluginsView';
