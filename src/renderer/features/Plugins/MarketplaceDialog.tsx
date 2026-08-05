import { memo, useCallback, useEffect, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/renderer/ds/ui/dialog';
import { Input } from '@/renderer/ds/ui/input';
import { Spinner } from '@/renderer/ds/ui/spinner';
import type { ExploreContext } from '@/renderer/features/Plugins/ExploreSection';
import { ExploreCard, installKeyOf } from '@/renderer/features/Plugins/ExploreSection';
import type { ExplorePlugin } from '@/renderer/features/Plugins/plugin-cards';
import { buildExplorePlugins } from '@/renderer/features/Plugins/plugin-cards';
import { emitter } from '@/renderer/services/ipc';
import type { MarketplaceManifest } from '@/shared/types';

const DEFAULT_MARKETPLACE = 'anthropics/skills';

type MarketplaceDialogProps = {
  open: boolean;
  onClose: () => void;
  ctx: ExploreContext;
  installingKey: string | null;
  onInstall: (item: ExplorePlugin, mode: 'install' | 'update') => void;
};

/**
 * Browse any `owner/repo` marketplace and install its connectors, skill
 * bundles, and apps — the manual-entry counterpart to the featured sections.
 */
export const MarketplaceDialog = memo(({ open, onClose, ctx, installingKey, onInstall }: MarketplaceDialogProps) => {
  const [repo, setRepo] = useState(DEFAULT_MARKETPLACE);
  const [manifest, setManifest] = useState<MarketplaceManifest | null>(null);
  const [fetching, setFetching] = useState(false);
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
      return;
    }
    // Auto-load the default marketplace so users don't have to click "Load" first.
    if (repo === DEFAULT_MARKETPLACE) {
      void onFetch();
    }
  }, [open, repo, onFetch]);

  const items = manifest ? buildExplorePlugins(repo, manifest, ctx) : [];

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Browse a marketplace</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/repo"
                aria-label="Marketplace repository"
                className="flex-1"
              />

              <Button size="sm" onClick={onFetch} disabled={fetching || !repo.trim()}>
                {fetching ? <Spinner /> : 'Load'}
              </Button>
            </div>

            {error && <div className="p-4 rounded-lg bg-destructive/10 text-destructive text-xs">{error}</div>}

            {manifest &&
              (items.length === 0 ? (
                <div className="text-muted-foreground text-xs">This marketplace has nothing to install.</div>
              ) : (
                <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
                  {items.map((item) => (
                    <ExploreCard
                      key={installKeyOf(item)}
                      item={item}
                      installingKey={installingKey}
                      onInstall={onInstall}
                    />
                  ))}
                </div>
              ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
MarketplaceDialog.displayName = 'MarketplaceDialog';
