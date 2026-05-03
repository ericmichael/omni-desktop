import { makeStyles, mergeClasses, shorthands,tokens } from '@fluentui/react-components';
import { ArrowLeft20Regular, DataBarVertical20Regular, Open20Regular } from '@fluentui/react-icons';
import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';

import { emitter } from '@/renderer/services/ipc';
import { persistedStoreApi } from '@/renderer/services/store';
import type { PlatformDashboard } from '@/shared/types';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: tokens.colorNeutralBackground1 },
  rootGlass: {
    backgroundColor: tokens.colorNeutralBackground1,
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  dashCardGlass: {
    backgroundColor: tokens.colorNeutralBackground3,
    backdropFilter: 'var(--glass-blur-light)',
    WebkitBackdropFilter: 'var(--glass-blur-light)',
  },
  embedHeaderGlass: {
    backgroundColor: tokens.colorNeutralBackground2,
    backdropFilter: 'var(--glass-blur-light)',
    WebkitBackdropFilter: 'var(--glass-blur-light)',
  },
  listHeader: {
    paddingLeft: tokens.spacingHorizontalXL,
    paddingRight: tokens.spacingHorizontalXL,
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalL,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
  },
  listTitle: { fontSize: '24px', fontWeight: tokens.fontWeightBold, color: tokens.colorNeutralForeground1, letterSpacing: '-0.025em' },
  listSubtitle: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground3, marginTop: '4px' },
  listBody: { flex: '1 1 0', overflowY: 'auto', padding: tokens.spacingHorizontalXL },
  loading: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '128px', color: tokens.colorNeutralForeground2 },
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '128px', color: tokens.colorNeutralForeground2 },
  emptyIcon: { marginBottom: tokens.spacingVerticalS, opacity: 0.4 },
  emptyHint: { fontSize: tokens.fontSizeBase200, marginTop: '4px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: tokens.spacingVerticalL,
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, 1fr)' },
    '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(3, 1fr)' },
  },
  dashCard: {
    display: 'flex',
    flexDirection: 'column',
    textAlign: 'left',
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    transitionProperty: 'background-color',
    transitionDuration: '150ms',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  dashCardTop: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' },
  dashCardIcon: { color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: '2px' },
  dashCardOpenIcon: { color: tokens.colorNeutralForeground2, opacity: 0, transitionProperty: 'opacity', transitionDuration: '150ms' },
  dashCardName: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1, marginTop: tokens.spacingVerticalS, lineHeight: '1.375' },
  dashCardWidgets: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, marginTop: '4px' },
  embedHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    paddingTop: '10px',
    paddingBottom: '10px',
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke1),
    backgroundColor: tokens.colorNeutralBackground2,
    flexShrink: 0,
  },
  backBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    transitionProperty: 'color',
    transitionDuration: '150ms',
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  embedTitleWrap: { flex: '1 1 0', minWidth: 0 },
  embedTitle: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  openLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    transitionProperty: 'color',
    transitionDuration: '150ms',
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  embedBody: { flex: '1 1 0', minHeight: 0 },
  iframe: { width: '100%', height: '100%', border: 'none' },
});

/**
 * Dashboards tab — shows entitled Databricks dashboards from platform policy.
 *
 * Dashboards are published with embed_credentials=true on Databricks,
 * so the /embed/ URL works in any iframe without separate authentication.
 * The publisher's credentials are used to execute queries — governed by
 * the platform's entitlement system (only entitled dashboards appear).
 */
export const Dashboards = memo(() => {
  const [dashboards, setDashboards] = useState<PlatformDashboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeDashboard, setActiveDashboard] = useState<PlatformDashboard | null>(null);
  const isGlass = useStore(persistedStoreApi.$atom).codeDeckBackground != null;

  useEffect(() => {
    emitter
      .invoke('platform:get-dashboards')
      .then((result) => setDashboards(result ?? []))
      .catch(() => setDashboards([]))
      .finally(() => setLoading(false));
  }, []);

  const openDashboard = useCallback((d: PlatformDashboard) => {
    setActiveDashboard(d);
  }, []);

  const closeDashboard = useCallback(() => {
    setActiveDashboard(null);
  }, []);

  if (activeDashboard) {
    return <DashboardEmbed dashboard={activeDashboard} onBack={closeDashboard} isGlass={isGlass} />;
  }

  return <DashboardList dashboards={dashboards} loading={loading} onOpen={openDashboard} isGlass={isGlass} />;
});
Dashboards.displayName = 'Dashboards';

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

const DashboardList = memo(
  ({
    dashboards,
    loading,
    onOpen,
    isGlass,
  }: {
    dashboards: PlatformDashboard[];
    loading: boolean;
    onOpen: (d: PlatformDashboard) => void;
    isGlass: boolean;
  }) => {
    const styles = useStyles();
    return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
      <div className={styles.listHeader}>
        <h1 className={styles.listTitle}>Dashboards</h1>
        <p className={styles.listSubtitle}>Your entitled Databricks dashboards</p>
      </div>

      <div className={styles.listBody}>
        {loading && (
          <div className={styles.loading}>Loading dashboards...</div>
        )}

        {!loading && dashboards.length === 0 && (
          <div className={styles.emptyState}>
            <DataBarVertical20Regular style={{ width: 32, height: 32 }} className={styles.emptyIcon} />
            <p>No dashboards available.</p>
            <p className={styles.emptyHint}>Request access from your domain admin.</p>
          </div>
        )}

        {!loading && dashboards.length > 0 && (
          <div className={styles.grid}>
            {dashboards.map((d) => (
              <button
                key={d.resource_id}
                onClick={() => onOpen(d)}
                className={mergeClasses(styles.dashCard, isGlass && styles.dashCardGlass)}
              >
                <div className={styles.dashCardTop}>
                  <DataBarVertical20Regular className={styles.dashCardIcon} />
                  <Open20Regular
                    style={{ width: 14, height: 14 }}
                    className={styles.dashCardOpenIcon} />
                </div>
                <h3 className={styles.dashCardName}>{d.name}</h3>
                <p className={styles.dashCardWidgets}>{d.widget_count} widgets</p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
    );
  }
);
DashboardList.displayName = 'DashboardList';

// ---------------------------------------------------------------------------
// Embed view
// ---------------------------------------------------------------------------

const DashboardEmbed = memo(
  ({
    dashboard,
    onBack,
    isGlass,
  }: {
    dashboard: PlatformDashboard;
    onBack: () => void;
    isGlass: boolean;
  }) => {
    const styles = useStyles();
    return (
    <div className={mergeClasses(styles.root, isGlass && styles.rootGlass)}>
      {/* Header bar */}
      <div className={mergeClasses(styles.embedHeader, isGlass && styles.embedHeaderGlass)}>
        <button
          onClick={onBack}
          className={styles.backBtn}
        >
          <ArrowLeft20Regular style={{ width: 16, height: 16 }} />
          <span>Back</span>
        </button>
        <div className={styles.embedTitleWrap}>
          <h2 className={styles.embedTitle}>{dashboard.name}</h2>
        </div>
        <a
          href={dashboard.workspace_url}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.openLink}
        >
          <Open20Regular style={{ width: 14, height: 14 }} />
          <span>Open in Databricks</span>
        </a>
      </div>

      {/* Embedded dashboard — uses published embed URL with embed_credentials */}
      <div className={styles.embedBody}>
        <iframe
          src={dashboard.embed_url}
          className={styles.iframe}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          title={dashboard.name}
        />
      </div>
    </div>
    );
  }
);
DashboardEmbed.displayName = 'DashboardEmbed';
