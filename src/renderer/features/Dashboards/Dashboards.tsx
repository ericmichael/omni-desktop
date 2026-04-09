import { memo, useCallback, useEffect, useState } from 'react';
import { PiArrowLeft, PiChartBarBold, PiArrowSquareOutBold } from 'react-icons/pi';

import { cn } from '@/renderer/ds';
import { emitter } from '@/renderer/services/ipc';
import type { PlatformDashboard } from '@/shared/types';

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
    return <DashboardEmbed dashboard={activeDashboard} onBack={closeDashboard} />;
  }

  return <DashboardList dashboards={dashboards} loading={loading} onOpen={openDashboard} />;
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
  }: {
    dashboards: PlatformDashboard[];
    loading: boolean;
    onOpen: (d: PlatformDashboard) => void;
  }) => (
    <div className="flex flex-col w-full h-full bg-surface">
      <div className="px-5 pt-6 pb-4 border-b border-border">
        <h1 className="text-2xl font-bold text-fg tracking-tight">Dashboards</h1>
        <p className="text-sm text-fg-subtle mt-1">Your entitled Databricks dashboards</p>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {loading && (
          <div className="flex items-center justify-center h-32 text-fg-muted">Loading dashboards...</div>
        )}

        {!loading && dashboards.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-fg-muted">
            <PiChartBarBold size={32} className="mb-2 opacity-40" />
            <p>No dashboards available.</p>
            <p className="text-xs mt-1">Request access from your domain admin.</p>
          </div>
        )}

        {!loading && dashboards.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {dashboards.map((d) => (
              <button
                key={d.resource_id}
                onClick={() => onOpen(d)}
                className={cn(
                  'flex flex-col text-left p-4 rounded-lg border border-border',
                  'bg-surface-raised hover:bg-surface-raised-hover',
                  'transition-colors cursor-pointer group'
                )}
              >
                <div className="flex items-start justify-between">
                  <PiChartBarBold size={20} className="text-accent-500 shrink-0 mt-0.5" />
                  <PiArrowSquareOutBold
                    size={14}
                    className="text-fg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                  />
                </div>
                <h3 className="text-sm font-semibold text-fg mt-2 leading-snug">{d.name}</h3>
                <p className="text-xs text-fg-muted mt-1">{d.widget_count} widgets</p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
);
DashboardList.displayName = 'DashboardList';

// ---------------------------------------------------------------------------
// Embed view
// ---------------------------------------------------------------------------

const DashboardEmbed = memo(
  ({
    dashboard,
    onBack,
  }: {
    dashboard: PlatformDashboard;
    onBack: () => void;
  }) => (
    <div className="flex flex-col w-full h-full bg-surface">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-surface-raised shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg transition-colors cursor-pointer"
        >
          <PiArrowLeft size={16} />
          <span>Back</span>
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-fg truncate">{dashboard.name}</h2>
        </div>
        <a
          href={dashboard.workspace_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg transition-colors"
        >
          <PiArrowSquareOutBold size={14} />
          <span>Open in Databricks</span>
        </a>
      </div>

      {/* Embedded dashboard — uses published embed URL with embed_credentials */}
      <div className="flex-1 min-h-0">
        <iframe
          src={dashboard.embed_url}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          title={dashboard.name}
        />
      </div>
    </div>
  )
);
DashboardEmbed.displayName = 'DashboardEmbed';
