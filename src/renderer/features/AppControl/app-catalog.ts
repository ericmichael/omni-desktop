/**
 * Live wrapper around the pure catalog builder (`app-catalog-core.ts`): gathers
 * `$liveApps`, per-column sandbox `services` (`$agentStatuses`), and the
 * persisted store, then builds the `list_apps` catalog for the caller's scope.
 */
import { buildAppCatalog, type CatalogApp } from '@/renderer/features/AppControl/app-catalog-core';
import { $liveApps } from '@/renderer/features/AppControl/live-registry';
import { $agentStatuses } from '@/renderer/services/agent-process';
import { persistedStoreApi } from '@/renderer/services/store';
import type { AppScopeFilter } from '@/shared/app-control-types';
import { buildAppRegistry } from '@/shared/app-registry';

export type { CatalogApp } from '@/renderer/features/AppControl/app-catalog-core';
export { buildAppCatalog } from '@/renderer/features/AppControl/app-catalog-core';

/** Gather live state and build the catalog for the caller's scope. */
export function listAppsForScope(filter: AppScopeFilter): CatalogApp[] {
  const store = persistedStoreApi.get();
  const registry = buildAppRegistry(store.customApps ?? []);

  const servicesByTab: Record<string, Record<string, string> | undefined> = {};
  for (const [pid, st] of Object.entries($agentStatuses.get())) {
    if (st?.type === 'running') {
      servicesByTab[pid] = st.data.services;
    }
  }

  const projects = store.projects ?? [];
  const tickets = store.tickets ?? [];
  const codeTabs = store.codeTabs ?? [];
  const columnInfo = (tabId: string): { sessionId?: string; project?: string; ticket?: string } => {
    const tab = codeTabs.find((t) => t.id === tabId);
    return {
      sessionId: tab?.sessionId,
      project: tab?.projectId ? projects.find((p) => p.id === tab.projectId)?.label : undefined,
      ticket: tab?.ticketId ? (tickets.find((t) => t.id === tab.ticketId)?.title ?? tab.ticketTitle) : undefined,
    };
  };

  return buildAppCatalog({
    filter,
    live: $liveApps.get(),
    registry,
    codeTabs,
    servicesByTab,
    columnInfo,
  });
}
