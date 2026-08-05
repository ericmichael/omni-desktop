import { Lightbulb, PlugZap } from 'lucide-react';
import { memo } from 'react';

import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/renderer/ds/ui/item';
import { Spinner } from '@/renderer/ds/ui/spinner';
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

function cardIcon(item: ExplorePlugin) {
  switch (item.kind) {
    case 'connector':
      return item.connector.icon ? <AppIcon icon={item.connector.icon} size={20} /> : <PlugZap className="size-5" />;
    case 'skill':
      return <Lightbulb className="size-5" />;
    case 'app':
      return <AppIcon icon={item.app.icon} size={20} />;
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
    <Item variant="outline">
      <ItemMedia variant="icon">{cardIcon(item)}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full truncate">{displayName(item)}</ItemTitle>
        <ItemDescription>{cardDescription(item)}</ItemDescription>
        {hasUpdate && (
          <Badge variant="outline" className="mt-1 text-success">
            {item.kind === 'skill' && item.update ? formatUpdateSummary(item.update) : 'Update available'}
          </Badge>
        )}
      </ItemContent>
      <ItemActions>
        <Button
          size="sm"
          variant={disabled ? 'ghost' : 'default'}
          onClick={() => onInstall(item, mode)}
          disabled={disabled}
        >
          {installing ? <Spinner /> : label}
        </Button>
      </ItemActions>
    </Item>
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
    if (failed) {
      return null;
    }

    if (manifest === null) {
      return (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {marketplace.label}
          </span>
          <Item variant="outline" className="justify-center">
            <Spinner />
          </Item>
        </div>
      );
    }

    const items = filterPlugins(buildExplorePlugins(marketplace.repo, manifest, ctx), filter, query);
    if (items.length === 0) {
      return null;
    }

    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {marketplace.label}
        </span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <ExploreCard key={installKeyOf(item)} item={item} installingKey={installingKey} onInstall={onInstall} />
          ))}
        </div>
      </div>
    );
  }
);
ExploreSection.displayName = 'ExploreSection';
