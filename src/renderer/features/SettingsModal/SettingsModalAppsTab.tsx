import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  Add20Regular,
  Delete20Regular,
  Globe20Regular,
  MusicNote220Regular,
  News20Regular,
  People20Regular,
  PersonBoard20Regular,
  SlideLayout20Regular,
  Star20Regular,
  Video20Regular,
} from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { uuidv4 } from '@/lib/uuid';
import { Button, FormSkeleton, SectionLabel } from '@/renderer/ds';
import { FormField } from '@/renderer/ds/FormField';
import { Input } from '@/renderer/ds/Input';
import { AppIcon } from '@/renderer/features/Code/AppIcon';
import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { CustomAppEntry } from '@/shared/app-registry';
import type { MarketplaceApp, MarketplaceManifest } from '@/shared/types';

type FluentIcon = typeof Globe20Regular;

const ICON_OPTIONS: { name: string; Icon: FluentIcon }[] = [
  { name: 'Globe20Regular', Icon: Globe20Regular },
  { name: 'People20Regular', Icon: People20Regular },
  { name: 'Video20Regular', Icon: Video20Regular },
  { name: 'MusicNote220Regular', Icon: MusicNote220Regular },
  { name: 'News20Regular', Icon: News20Regular },
  { name: 'Star20Regular', Icon: Star20Regular },
  { name: 'SlideLayout20Regular', Icon: SlideLayout20Regular },
  { name: 'PersonBoard20Regular', Icon: PersonBoard20Regular },
];

const FEATURED_MARKETPLACE = 'ericmichael/omni-plugins-official';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  description: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, lineHeight: '1.4' },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
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
  cardInfo: { flex: 1, minWidth: 0 },
  cardLabel: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  cardUrl: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  removeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
    transitionProperty: 'color, background-color',
    transitionDuration: '120ms',
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
      color: tokens.colorPaletteRedForeground1,
    },
  },
  addForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: tokens.spacingHorizontalL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  addFormActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalS,
    marginTop: '4px',
  },
  iconGrid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
    marginTop: '4px',
  },
  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
    transitionProperty: 'border-color, color, background-color',
    transitionDuration: '120ms',
    ':hover': {
      borderColor: tokens.colorNeutralStroke1,
      color: tokens.colorNeutralForeground1,
    },
  },
  iconBtnSelected: {
    borderColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  empty: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  marketplaceGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalS,
  },
  marketplaceCard: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  marketplaceCardLabel: {
    flex: 1,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  marketplaceCardInstalled: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
});

function isValidUrl(str: string): boolean {
  const trimmed = str.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Installed App Card
// ---------------------------------------------------------------------------

const AppCard = memo(({ app, onRemove }: { app: CustomAppEntry; onRemove: (id: string) => void }) => {
  const styles = useStyles();

  return (
    <div className={styles.card}>
      <div className={styles.cardIcon}>
        <AppIcon icon={app.icon} size={20} />
      </div>
      <div className={styles.cardInfo}>
        <div className={styles.cardLabel}>{app.label}</div>
        <div className={styles.cardUrl}>{app.url}</div>
      </div>
      <button type="button" className={styles.removeBtn} onClick={() => onRemove(app.id)} aria-label={`Remove ${app.label}`} title="Remove">
        <Delete20Regular style={{ width: 16, height: 16 }} />
      </button>
    </div>
  );
});
AppCard.displayName = 'AppCard';

// ---------------------------------------------------------------------------
// Featured Marketplace Apps
// ---------------------------------------------------------------------------

function isAppInstalled(customApps: CustomAppEntry[], marketplaceApp: MarketplaceApp): boolean {
  return customApps.some((a) => a.url === marketplaceApp.url);
}

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
  };
  void persistedStoreApi.setKey('customApps', [...current, entry]);
}

const FeaturedApps = memo(({ customApps }: { customApps: CustomAppEntry[] }) => {
  const styles = useStyles();
  const [manifest, setManifest] = useState<MarketplaceManifest | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    emitter
      .invoke('skills:fetch-marketplace', FEATURED_MARKETPLACE)
      .then((result) => {
        if (!cancelled) {
          setManifest(result);
        }
      })
      .catch(() => {
        // Silently hide if marketplace is unreachable
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <FormSkeleton fields={2} />;
  }

  const apps = manifest?.apps;
  if (!apps || apps.length === 0) {
    return null;
  }

  return (
    <div className={styles.section}>
      <SectionLabel>Marketplace</SectionLabel>
      <div className={styles.marketplaceGrid}>
        {apps.map((app) => {
          const installed = isAppInstalled(customApps, app);
          return (
            <div key={app.id} className={styles.marketplaceCard}>
              <div className={styles.cardIcon}>
                <AppIcon icon={app.icon} size={18} />
              </div>
              <span className={styles.marketplaceCardLabel}>{app.label}</span>
              {installed ? (
                <span className={styles.marketplaceCardInstalled}>Added</span>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => installMarketplaceApp(app)}>
                  <Add20Regular style={{ width: 13, height: 13 }} />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
FeaturedApps.displayName = 'FeaturedApps';

// ---------------------------------------------------------------------------
// Main Tab
// ---------------------------------------------------------------------------

export const SettingsModalAppsTab = memo(() => {
  const styles = useStyles();
  const store = useStore(persistedStoreApi.$atom);
  const customApps = store.customApps ?? [];

  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [icon, setIcon] = useState('Globe20Regular');

  const isValid = label.trim().length > 0 && isValidUrl(url);

  const handleAdd = useCallback(() => {
    if (!isValid) {
      return;
    }
    const current = persistedStoreApi.$atom.get().customApps ?? [];
    const maxOrder = current.reduce((max, a) => Math.max(max, a.order), 40);
    const entry: CustomAppEntry = {
      id: uuidv4(),
      label: label.trim(),
      icon,
      url: url.trim(),
      order: maxOrder + 10,
    };
    void persistedStoreApi.setKey('customApps', [...current, entry]);
    setLabel('');
    setUrl('');
    setIcon('Globe20Regular');
    setShowForm(false);
  }, [isValid, label, url, icon]);

  const handleCancel = useCallback(() => {
    setLabel('');
    setUrl('');
    setIcon('Globe20Regular');
    setShowForm(false);
  }, []);

  const handleRemove = useCallback((id: string) => {
    const current = persistedStoreApi.$atom.get().customApps ?? [];
    void persistedStoreApi.setKey('customApps', current.filter((a) => a.id !== id));
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.description}>
        Add web apps to your workspace. Custom apps open as standalone columns in the deck.
      </div>

      <FeaturedApps customApps={customApps} />

      <div className={styles.section}>
        <SectionLabel>Installed</SectionLabel>
        {customApps.length === 0 && !showForm && (
          <div className={styles.empty}>No custom apps added yet.</div>
        )}

        {customApps.map((app) => (
          <AppCard key={app.id} app={app} onRemove={handleRemove} />
        ))}

        {showForm ? (
          <div className={styles.addForm}>
            <FormField label="Label">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Teams" autoFocus />
            </FormField>
            <FormField label="URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." type="url" />
            </FormField>
            <FormField label="Icon">
              <div className={styles.iconGrid}>
                {ICON_OPTIONS.map(({ name, Icon: Ic }) => (
                  <button
                    key={name}
                    type="button"
                    className={mergeClasses(styles.iconBtn, icon === name && styles.iconBtnSelected)}
                    onClick={() => setIcon(name)}
                    aria-label={name}
                    title={name}
                  >
                    <Ic style={{ width: 20, height: 20 }} />
                  </button>
                ))}
              </div>
            </FormField>
            <div className={styles.addFormActions}>
              <Button size="sm" variant="ghost" onClick={handleCancel}>Cancel</Button>
              <Button size="sm" onClick={handleAdd} isDisabled={!isValid}>Add</Button>
            </div>
          </div>
        ) : (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setShowForm(true)}>Add custom app</Button>
          </div>
        )}
      </div>
    </div>
  );
});
SettingsModalAppsTab.displayName = 'SettingsModalAppsTab';
