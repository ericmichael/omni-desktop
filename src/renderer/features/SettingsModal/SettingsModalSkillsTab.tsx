import { makeStyles, tokens } from '@fluentui/react-components';
import { ArrowDownload20Regular, Delete20Regular, Globe20Regular } from '@fluentui/react-icons';
import { memo, useCallback, useEffect, useState } from 'react';

import {
  AnimatedDialog,
  Button,
  ConfirmDialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  FormSkeleton,
  IconButton,
  Input,
  SectionLabel,
  Spinner,
  Switch,
} from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';
import type {
  BundleUpdateInfo,
  MarketplaceManifest,
  MarketplacePlugin,
  SkillEntry,
} from '@/shared/types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  empty: {
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
  },
  featuredSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  installedSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  featuredCard: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingHorizontalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  featuredText: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  featuredLabel: {
    fontWeight: 600,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  featuredDescription: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  updateBadge: {
    marginTop: tokens.spacingVerticalXXS,
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorPaletteGreenForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  cardTitle: {
    flex: 1,
    fontWeight: 600,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  cardDescription: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  cardMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground4,
  },
  errorBanner: {
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  marketplaceForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  marketplaceList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    maxHeight: '24rem',
    overflowY: 'auto',
  },
  pluginRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  pluginRowHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  pluginName: {
    flex: 1,
    fontWeight: 600,
    fontSize: tokens.fontSizeBase300,
  },
  pluginDescription: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    lineHeight: tokens.lineHeightBase200,
  },
  pluginMeta: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground4,
  },
});

const SKILL_FILE_FILTERS = [{ name: 'Skill packages', extensions: ['skill'] }];
const DEFAULT_MARKETPLACE = 'anthropics/skills';

/**
 * Curated marketplaces to feature. Only the repo + display label are local;
 * each marketplace's bundle list, names, and descriptions are pulled live
 * from its `marketplace.json` so they can't drift from the source.
 */
type FeaturedMarketplace = {
  /** Display heading shown above the bundle row. */
  label: string;
  /** Repo spec passed to `skills:fetch-marketplace` (e.g. `owner/repo`). */
  repo: string;
};

const FEATURED_MARKETPLACES: FeaturedMarketplace[] = [
  { label: 'Omni Official', repo: 'ericmichael/omni-plugins-official' },
  { label: 'Anthropic', repo: 'anthropics/skills' },
];

/** Title-case a kebab-case plugin id for display ("git-workflow" → "Git Workflow"). */
function formatPluginName(id: string): string {
  return id
    .split('-')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

export const SettingsModalSkillsTab = memo(() => {
  const styles = useStyles();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [updates, setUpdates] = useState<Record<string, BundleUpdateInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<SkillEntry | null>(null);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [installingFeatured, setInstallingFeatured] = useState<string | null>(null);

  const refreshUpdates = useCallback(async () => {
    try {
      const reports = await emitter.invoke('skills:check-bundle-updates');
      const map: Record<string, BundleUpdateInfo> = {};
      for (const r of reports) {
map[r.bundleKey] = r;
}
      setUpdates(map);
    } catch {
      // Network failures shouldn't block the tab — the per-bundle UI already
      // has an "unreachable" state if individual bundles fail.
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await emitter.invoke('skills:list');
      setSkills(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load skills');
    } finally {
      setLoading(false);
    }
    void refreshUpdates();
  }, [refreshUpdates]);

  useEffect(() => {
    load();
  }, [load]);

  const installFromFile = useCallback(async () => {
    setError(null);
    const filePath = await emitter.invoke('util:select-file', undefined, SKILL_FILE_FILTERS);
    if (!filePath) {
return;
}
    try {
      await emitter.invoke('skills:install', filePath);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to install skill');
    }
  }, [load]);

  const onToggle = useCallback(
    async (name: string, enabled: boolean) => {
      await emitter.invoke('skills:set-enabled', name, enabled);
      await load();
    },
    [load]
  );

  const installFeatured = useCallback(
    async (repo: string, plugin: string, mode: 'install' | 'update') => {
      setError(null);
      setInstallingFeatured(plugin);
      try {
        const channel =
          mode === 'update' ? 'skills:update-marketplace-plugin' : 'skills:install-marketplace-plugin';
        await emitter.invoke(channel, repo, plugin);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to ${mode} plugin`);
      } finally {
        setInstallingFeatured(null);
      }
    },
    [load]
  );

  const confirmUninstall = useCallback(async () => {
    if (!uninstallTarget) {
return;
}
    setError(null);
    try {
      await emitter.invoke('skills:uninstall', uninstallTarget.name);
      setUninstallTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to uninstall skill');
    }
  }, [uninstallTarget, load]);

  if (loading) {
return <FormSkeleton fields={4} />;
}

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <SectionLabel>Skills</SectionLabel>
        <div className={styles.headerActions}>
          <Button size="sm" variant="ghost" onClick={() => setMarketplaceOpen(true)}>
            <Globe20Regular style={{ marginRight: 4 }} />
            Install from marketplace
          </Button>
          <Button size="sm" variant="ghost" onClick={installFromFile}>
            <ArrowDownload20Regular style={{ marginRight: 4 }} />
            Install from file
          </Button>
        </div>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      <FeaturedBundles
        skills={skills}
        updates={updates}
        installingPlugin={installingFeatured}
        onInstall={installFeatured}
      />

      {skills.length > 0 && (
        <div className={styles.installedSection}>
          <SectionLabel>Installed</SectionLabel>
          {skills.map((skill) => (
            <SkillCard
              key={skill.name}
              skill={skill}
              onToggle={onToggle}
              onUninstall={setUninstallTarget}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={uninstallTarget !== null}
        onClose={() => setUninstallTarget(null)}
        onConfirm={confirmUninstall}
        title={`Uninstall "${uninstallTarget?.name}"?`}
        description="This will permanently remove the skill and all its files."
        confirmLabel="Uninstall"
        destructive
      />

      <MarketplaceDialog
        open={marketplaceOpen}
        onClose={() => setMarketplaceOpen(false)}
        onInstalled={load}
      />
    </div>
  );
});
SettingsModalSkillsTab.displayName = 'SettingsModalSkillsTab';

// ---------------------------------------------------------------------------
// Featured Bundles
// ---------------------------------------------------------------------------

type FeaturedBundlesProps = {
  skills: SkillEntry[];
  updates: Record<string, BundleUpdateInfo>;
  installingPlugin: string | null;
  onInstall: (repo: string, plugin: string, mode: 'install' | 'update') => void;
};

/** True if any installed skill came from this marketplace bundle. */
function isBundleInstalled(skills: SkillEntry[], repo: string, plugin: string): boolean {
  return skills.some(
    (s) => s.source.kind === 'marketplace' && s.source.repo === repo && s.source.plugin === plugin
  );
}

const FeaturedBundles = memo(
  ({ skills, updates, installingPlugin, onInstall }: FeaturedBundlesProps) => {
    return (
      <>
        {FEATURED_MARKETPLACES.map((marketplace) => (
          <FeaturedMarketplaceSection
            key={marketplace.label}
            marketplace={marketplace}
            skills={skills}
            updates={updates}
            installingPlugin={installingPlugin}
            onInstall={onInstall}
          />
        ))}
      </>
    );
  }
);
FeaturedBundles.displayName = 'FeaturedBundles';

type FeaturedMarketplaceSectionProps = {
  marketplace: FeaturedMarketplace;
  skills: SkillEntry[];
  updates: Record<string, BundleUpdateInfo>;
  installingPlugin: string | null;
  onInstall: (repo: string, plugin: string, mode: 'install' | 'update') => void;
};

const FeaturedMarketplaceSection = memo(
  ({ marketplace, skills, updates, installingPlugin, onInstall }: FeaturedMarketplaceSectionProps) => {
    const styles = useStyles();
    const [manifest, setManifest] = useState<MarketplaceManifest | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
      let cancelled = false;
      setManifest(null);
      setFailed(false);
      emitter
        .invoke('skills:fetch-marketplace', marketplace.repo)
        .then((result) => {
          if (!cancelled) {
setManifest(result);
}
        })
        .catch(() => {
          if (!cancelled) {
setFailed(true);
}
        });
      return () => {
        cancelled = true;
      };
    }, [marketplace.repo]);

    // Hide the section entirely on fetch failure — the marketplace dialog is
    // still available for users who want to retry manually.
    if (failed) {
return null;
}

    return (
      <div className={styles.featuredSection}>
        <SectionLabel>{marketplace.label}</SectionLabel>
        {manifest === null ? (
          <div className={styles.featuredCard}>
            <Spinner size="sm" />
          </div>
        ) : (
          manifest.plugins.map((plugin) => {
              const installed = isBundleInstalled(skills, marketplace.repo, plugin.name);
              const installing = installingPlugin === plugin.name;
              const otherInstalling = installingPlugin !== null && !installing;
              const update = updates[`${marketplace.repo}:${plugin.name}`];
              const hasUpdate = installed && update?.status === 'update-available';

              const mode: 'install' | 'update' = installed ? 'update' : 'install';
              let label: string;
              if (installing) {
label = mode === 'update' ? 'Updating…' : 'Installing…';
} else if (hasUpdate) {
label = 'Update';
} else if (installed) {
label = 'Installed';
} else {
label = 'Install';
}

              const disabled = otherInstalling || (installed && !hasUpdate);

              return (
                <div key={plugin.name} className={styles.featuredCard}>
                  <div className={styles.featuredText}>
                    <span className={styles.featuredLabel}>{formatPluginName(plugin.name)}</span>
                    <span className={styles.featuredDescription}>{plugin.description}</span>
                    {hasUpdate && (
                      <span className={styles.updateBadge}>
                        {formatUpdateSummary(update)}
                      </span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant={installed && !hasUpdate ? 'ghost' : 'primary'}
                    onClick={() => onInstall(marketplace.repo, plugin.name, mode)}
                    isDisabled={disabled}
                  >
                    {installing ? <Spinner size="sm" /> : label}
                  </Button>
                </div>
              );
            })
        )}
      </div>
    );
  }
);
FeaturedMarketplaceSection.displayName = 'FeaturedMarketplaceSection';

/** Short human-readable summary of what changed upstream. */
function formatUpdateSummary(info: BundleUpdateInfo): string {
  const parts: string[] = [];
  if (info.liveVersion && info.liveVersion !== info.installedVersion) {
    parts.push(`v${info.installedVersion ?? '?'} → v${info.liveVersion}`);
  }
  if (info.addedSkills.length > 0) {
parts.push(`+${info.addedSkills.length} skill${info.addedSkills.length === 1 ? '' : 's'}`);
}
  if (info.removedSkills.length > 0) {
parts.push(`-${info.removedSkills.length} removed`);
}
  return parts.length > 0 ? `Update available · ${parts.join(' · ')}` : 'Update available';
}

// ---------------------------------------------------------------------------
// Skill Card
// ---------------------------------------------------------------------------

type SkillCardProps = {
  skill: SkillEntry;
  onToggle: (name: string, enabled: boolean) => void;
  onUninstall: (skill: SkillEntry) => void;
};

function formatSource(skill: SkillEntry): string {
  const parts: string[] = [];
  if (skill.version) {
parts.push(`v${skill.version}`);
}
  if (skill.source.kind === 'file') {
    parts.push(`Installed from ${skill.source.filename}`);
  } else if (skill.source.kind === 'marketplace') {
    parts.push(`Installed from ${skill.source.repo} · ${skill.source.plugin}`);
  } else {
    parts.push('Local');
  }
  return parts.join(' · ');
}

const SkillCard = memo(({ skill, onToggle, onUninstall }: SkillCardProps) => {
  const styles = useStyles();

  const handleToggle = useCallback(
    (checked: boolean) => onToggle(skill.name, checked),
    [skill.name, onToggle]
  );

  const handleUninstall = useCallback(() => onUninstall(skill), [skill, onUninstall]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>{skill.name}</span>
        <IconButton
          aria-label="Uninstall skill"
          icon={<Delete20Regular />}
          size="sm"
          onClick={handleUninstall}
        />
        <Switch checked={skill.enabled} onCheckedChange={handleToggle} />
      </div>
      <div className={styles.cardDescription}>{skill.description}</div>
      <div className={styles.cardMeta}>{formatSource(skill)}</div>
    </div>
  );
});
SkillCard.displayName = 'SkillCard';

// ---------------------------------------------------------------------------
// Marketplace Dialog
// ---------------------------------------------------------------------------

type MarketplaceDialogProps = {
  open: boolean;
  onClose: () => void;
  onInstalled: () => void;
};

const MarketplaceDialog = memo(({ open, onClose, onInstalled }: MarketplaceDialogProps) => {
  const styles = useStyles();
  const [repo, setRepo] = useState(DEFAULT_MARKETPLACE);
  const [manifest, setManifest] = useState<MarketplaceManifest | null>(null);
  const [fetching, setFetching] = useState(false);
  const [installingPlugin, setInstallingPlugin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFetch = useCallback(async () => {
    setError(null);
    setManifest(null);
    setFetching(true);
    try {
      const result = await emitter.invoke('skills:fetch-marketplace', repo);
      setManifest(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load marketplace');
    } finally {
      setFetching(false);
    }
  }, [repo]);

  useEffect(() => {
    if (!open) {
      setManifest(null);
      setError(null);
      setInstallingPlugin(null);
      return;
    }
    // Auto-load the default marketplace so users don't have to click "Load" first.
    if (repo === DEFAULT_MARKETPLACE) {
      void onFetch();
    }
  }, [open, repo, onFetch]);

  const onInstall = useCallback(
    async (plugin: MarketplacePlugin, mode: 'install' | 'update') => {
      setError(null);
      setInstallingPlugin(plugin.name);
      try {
        const channel =
          mode === 'update' ? 'skills:update-marketplace-plugin' : 'skills:install-marketplace-plugin';
        await emitter.invoke(channel, repo, plugin.name);
        onInstalled();
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to ${mode} plugin`);
      } finally {
        setInstallingPlugin(null);
      }
    },
    [repo, onInstalled]
  );

  return (
    <AnimatedDialog open={open} onClose={onClose}>
      <DialogContent>
        <DialogHeader>Install from marketplace</DialogHeader>
        <DialogBody>
          <div className={styles.marketplaceForm}>
            <div className={styles.headerActions}>
              <Input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/repo"
                aria-label="Marketplace repository"
              />
              <Button size="sm" onClick={onFetch} isDisabled={fetching || !repo.trim()}>
                {fetching ? <Spinner size="sm" /> : 'Load'}
              </Button>
            </div>

            {error && <div className={styles.errorBanner}>{error}</div>}

            {manifest && (
              <div className={styles.marketplaceList}>
                {manifest.plugins.map((plugin) => (
                  <div key={plugin.name} className={styles.pluginRow}>
                    <div className={styles.pluginRowHeader}>
                      <span className={styles.pluginName}>{plugin.name}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onInstall(plugin, 'install')}
                        isDisabled={installingPlugin !== null}
                      >
                        {installingPlugin === plugin.name ? <Spinner size="sm" /> : 'Install'}
                      </Button>
                    </div>
                    <div className={styles.pluginDescription}>{plugin.description}</div>
                    <div className={styles.pluginMeta}>
                      {plugin.skills.length} skill{plugin.skills.length === 1 ? '' : 's'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </AnimatedDialog>
  );
});
MarketplaceDialog.displayName = 'MarketplaceDialog';
