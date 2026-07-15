import { makeStyles, tokens } from '@fluentui/react-components';
import { Lightbulb20Regular, PlugConnected20Regular } from '@fluentui/react-icons';
import { memo } from 'react';

import { Button, SectionLabel, Spinner } from '@/renderer/ds';
import { AppIcon } from '@/renderer/features/Code/AppIcon';
import { formatUpdateSummary } from '@/renderer/features/Plugins/InstalledSection';
import type { ExplorePlugin, PluginKind } from '@/renderer/features/Plugins/plugin-cards';
import { buildExplorePlugins, displayName, filterPlugins } from '@/renderer/features/Plugins/plugin-cards';
import type { MarketplaceManifest } from '@/shared/types';

/** A curated marketplace featured on the Plugins page. */
export type FeaturedMarketplace = {
  /** Display heading shown above the card grid. */
  label: string;
  /** Repo spec passed to `skills:fetch-marketplace` (e.g. `owner/repo`). */
  repo: string;
};

export const FEATURED_MARKETPLACES: FeaturedMarketplace[] = [
  { label: 'Omni Official', repo: 'ericmichael/omni-plugins-official' },
  { label: 'Anthropic', repo: 'anthropics/skills' },
];

/** Stable identity for the one-install-at-a-time gate. */
export function installKeyOf(item: ExplorePlugin): string {
  switch (item.kind) {
    case 'connector':
      return `connector:${item.repo}:${item.connector.id}`;
    case 'skill':
      return `skill:${item.repo}:${item.plugin.name}`;
    case 'app':
      return `app:${item.repo}:${item.app.id}`;
  }
}

/** Context an explore card list needs to derive per-item installed state. */
export type ExploreContext = Parameters<typeof buildExplorePlugins>[2];

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalS,
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingHorizontalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cardIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
    flexShrink: 0,
  },
  cardText: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  cardLabel: {
    fontWeight: 600,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardDescription: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    lineHeight: tokens.lineHeightBase200,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
  },
  updateBadge: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorPaletteGreenForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  loadingCard: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: tokens.spacingVerticalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
});

function cardIcon(item: ExplorePlugin) {
  switch (item.kind) {
    case 'connector':
      return item.connector.icon ? <AppIcon icon={item.connector.icon} size={18} /> : <PlugConnected20Regular />;
    case 'skill':
      return <Lightbulb20Regular />;
    case 'app':
      return <AppIcon icon={item.app.icon} size={18} />;
  }
}

function cardDescription(item: ExplorePlugin): string {
  switch (item.kind) {
    case 'connector':
      return item.connector.description;
    case 'skill':
      return item.plugin.description;
    case 'app':
      return item.app.url;
  }
}

type ExploreCardProps = {
  item: ExplorePlugin;
  installingKey: string | null;
  onInstall: (item: ExplorePlugin, mode: 'install' | 'update') => void;
};

export const ExploreCard = memo(({ item, installingKey, onInstall }: ExploreCardProps) => {
  const styles = useStyles();
  const key = installKeyOf(item);
  const installing = installingKey === key;
  const otherInstalling = installingKey !== null && !installing;
  const hasUpdate = item.installed && (item.kind === 'skill' ? item.update !== undefined : item.needsUpdate);

  const mode: 'install' | 'update' = hasUpdate ? 'update' : 'install';
  let label: string;
  if (installing) {
    label = mode === 'update' ? 'Updating…' : 'Installing…';
  } else if (hasUpdate) {
    label = 'Update';
  } else if (item.installed) {
    label = 'Added';
  } else {
    label = item.kind === 'skill' ? 'Install' : 'Add';
  }
  const disabled = otherInstalling || (item.installed && !hasUpdate);

  return (
    <div className={styles.card}>
      <div className={styles.cardIcon}>{cardIcon(item)}</div>
      <div className={styles.cardText}>
        <span className={styles.cardLabel}>{displayName(item)}</span>
        <span className={styles.cardDescription}>{cardDescription(item)}</span>
        {hasUpdate && (
          <span className={styles.updateBadge}>
            {item.kind === 'skill' && item.update ? formatUpdateSummary(item.update) : 'Update available'}
          </span>
        )}
      </div>
      <Button
        size="sm"
        variant={disabled ? 'ghost' : 'primary'}
        onClick={() => onInstall(item, mode)}
        isDisabled={disabled}
      >
        {installing ? <Spinner size="sm" /> : label}
      </Button>
    </div>
  );
});
ExploreCard.displayName = 'ExploreCard';

type ExploreSectionProps = {
  marketplace: FeaturedMarketplace;
  /** Fetched at page level (useFeaturedManifests) so drift detection and "Update all" see every catalog. */
  manifest: MarketplaceManifest | null;
  failed: boolean;
  filter: PluginKind | 'all';
  query: string;
  ctx: ExploreContext;
  installingKey: string | null;
  onInstall: (item: ExplorePlugin, mode: 'install' | 'update') => void;
};

/**
 * One curated marketplace's featured grid. Hides itself entirely on fetch
 * failure (the marketplace dialog remains as the manual-retry path) or when
 * the current filter/search empties it.
 */
export const ExploreSection = memo(
  ({ marketplace, manifest, failed, filter, query, ctx, installingKey, onInstall }: ExploreSectionProps) => {
    const styles = useStyles();

    if (failed) {
      return null;
    }

    if (manifest === null) {
      return (
        <div className={styles.section}>
          <SectionLabel>{marketplace.label}</SectionLabel>
          <div className={styles.loadingCard}>
            <Spinner size="sm" />
          </div>
        </div>
      );
    }

    const items = filterPlugins(buildExplorePlugins(marketplace.repo, manifest, ctx), filter, query);
    if (items.length === 0) {
      return null;
    }

    return (
      <div className={styles.section}>
        <SectionLabel>{marketplace.label}</SectionLabel>
        <div className={styles.grid}>
          {items.map((item) => (
            <ExploreCard key={installKeyOf(item)} item={item} installingKey={installingKey} onInstall={onInstall} />
          ))}
        </div>
      </div>
    );
  }
);
ExploreSection.displayName = 'ExploreSection';
