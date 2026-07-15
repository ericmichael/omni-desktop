import { makeStyles, tokens } from '@fluentui/react-components';
import { memo, useCallback, useEffect, useState } from 'react';

import {
  AnimatedDialog,
  Button,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Input,
  Spinner,
} from '@/renderer/ds';
import type { ExploreContext } from '@/renderer/features/Plugins/ExploreSection';
import { ExploreCard, installKeyOf } from '@/renderer/features/Plugins/ExploreSection';
import type { ExplorePlugin } from '@/renderer/features/Plugins/plugin-cards';
import { buildExplorePlugins } from '@/renderer/features/Plugins/plugin-cards';
import { emitter } from '@/renderer/services/ipc';
import type { MarketplaceManifest } from '@/shared/types';

const DEFAULT_MARKETPLACE = 'anthropics/skills';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  fetchRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  flex1: { flex: '1 1 0' },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    maxHeight: '24rem',
    overflowY: 'auto',
  },
  empty: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  errorBanner: {
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
});

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
  const styles = useStyles();
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
    <AnimatedDialog open={open} onClose={onClose}>
      <DialogContent>
        <DialogHeader>Browse a marketplace</DialogHeader>
        <DialogBody>
          <div className={styles.form}>
            <div className={styles.fetchRow}>
              <Input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/repo"
                aria-label="Marketplace repository"
                className={styles.flex1}
              />
              <Button size="sm" onClick={onFetch} isDisabled={fetching || !repo.trim()}>
                {fetching ? <Spinner size="sm" /> : 'Load'}
              </Button>
            </div>

            {error && <div className={styles.errorBanner}>{error}</div>}

            {manifest &&
              (items.length === 0 ? (
                <div className={styles.empty}>This marketplace has nothing to install.</div>
              ) : (
                <div className={styles.list}>
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
