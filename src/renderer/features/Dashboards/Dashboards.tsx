import { ArrowLeft, ChartNoAxesColumnIncreasing, ExternalLink } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

import { useIsDesktop } from '@/renderer/common/use-is-desktop';
import { TopAppBar } from '@/renderer/ds/TopAppBar';
import { Button } from '@/renderer/ds/ui/button';
import { Card } from '@/renderer/ds/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/ds/ui/empty';
import { Spinner } from '@/renderer/ds/ui/spinner';
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
  }) => {
    const isDesktop = useIsDesktop();
    return (
      <div className="flex flex-col w-full h-full bg-background">
        {!isDesktop && <TopAppBar title="Dashboards" showMenu />}
        <div className="pl-6 pr-6 pt-8 pb-5">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Dashboards</h1>
          <p className="text-sm text-muted-foreground mt-1">Your entitled Databricks dashboards</p>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading && (
            <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner />
              Loading dashboards…
            </div>
          )}

          {!loading && dashboards.length === 0 && (
            <Empty className="h-32 p-4 md:p-4">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ChartNoAxesColumnIncreasing />
                </EmptyMedia>
                <EmptyTitle>No dashboards available</EmptyTitle>
                <EmptyDescription>Request access from your domain admin.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {!loading && dashboards.length > 0 && (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {dashboards.map((d) => (
                <Card key={d.resource_id} className="gap-0 overflow-hidden py-0">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto min-h-30 w-full flex-col items-stretch justify-start gap-0 whitespace-normal rounded-xl p-5 text-left"
                    onClick={() => onOpen(d)}
                  >
                    <div className="flex items-start justify-between">
                      <ChartNoAxesColumnIncreasing className="size-5 text-primary shrink-0 mt-0.5" />
                      <ExternalLink
                        className={`size-4 ${'text-muted-foreground opacity-0 transition-opacity duration-150'}`}
                      />
                    </div>
                    <h3 className="text-sm font-semibold text-foreground mt-2 leading-snug">{d.name}</h3>
                    <p className="text-xs text-muted-foreground mt-1">{d.widget_count} widgets</p>
                  </Button>
                </Card>
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

const DashboardEmbed = memo(({ dashboard, onBack }: { dashboard: PlatformDashboard; onBack: () => void }) => {
  return (
    <div className="flex flex-col w-full h-full bg-background">
      {/* Header bar */}
      <div className="flex shrink-0 items-center gap-4 border-b border-border bg-card px-5 py-2.5">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
          <span>Back</span>
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
            {dashboard.name}
          </h2>
        </div>
        <Button
          asChild
          variant="link"
          size="sm"
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <a href={dashboard.workspace_url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" />
            <span>Open in Databricks</span>
          </a>
        </Button>
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
  );
});
DashboardEmbed.displayName = 'DashboardEmbed';
