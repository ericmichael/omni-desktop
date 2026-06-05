/**
 * Pure catalog builder for `list_apps` — no live-store / IPC imports, so it is
 * unit-testable in isolation. The live wrapper that gathers `$liveApps`,
 * `$agentStatuses`, and the persisted store lives in `app-catalog.ts`.
 *
 * `list_apps` must report every app *available* in the caller's scope, each
 * annotated with whether it is currently *running* (a live webview is mounted).
 * The live registry only knows what's mounted, and dock apps mount lazily (one
 * non-chat app per column at a time), so this merges the available catalog
 * (`buildAppRegistry`, gated by per-column sandbox availability exactly as
 * `EnvironmentDock` gates it) with the running set.
 */
import type { AppHandleId, AppHandleScope, AppScopeFilter, LiveAppSnapshot } from '@/shared/app-control-types';
import { isControllableKind, makeAppHandleId } from '@/shared/app-control-types';
import type { AppDescriptor, AppId, AppKind } from '@/shared/app-registry';
import type { CodeTab } from '@/shared/types';

/** Map a descriptor's `sandboxUrlKey` to the sandbox `services` key. */
const SERVICE_KEY: Record<string, string> = {
  codeServerUrl: 'code_server',
  noVncUrl: 'vnc',
};

/** One row of `list_apps` output (pre-serialization). */
export type CatalogApp = {
  id: AppId;
  /** Canonical address — what superuser callers pass back as `app_id`. */
  handleId: AppHandleId;
  kind: AppKind;
  scope: AppHandleScope;
  label: string;
  controllable: boolean;
  /** A live webview is currently mounted for this app. */
  running: boolean;
  /** The app can be opened in this scope (sandbox services present, etc.). */
  available: boolean;
  url?: string;
  title?: string;
  /** Set for column-scoped apps. */
  tabId?: string;
  /** Column context — only attached for superuser callers. */
  column?: { tabId: string; sessionId?: string; project?: string; ticket?: string };
};

export type CatalogInput = {
  filter: AppScopeFilter;
  live: Record<AppHandleId, LiveAppSnapshot>;
  registry: AppDescriptor[];
  /** Session columns (excludes standalone app columns). */
  codeTabs: CodeTab[];
  /** Running sandbox `services` map per column id (for availability gating). */
  servicesByTab: Record<string, Record<string, string> | undefined>;
  /** Resolve display context for a column id (superuser only). */
  columnInfo: (tabId: string) => { sessionId?: string; project?: string; ticket?: string };
};

const descriptorAvailable = (app: AppDescriptor, services: Record<string, string> | undefined): boolean => {
  if (app.scope !== 'sandbox') {
    return true;
  }
  const serviceKey = SERVICE_KEY[app.sandboxUrlKey ?? ''];
  return !!(serviceKey && services?.[serviceKey]);
};

/** Pure: merge the available catalog with the running set for a scope. */
export function buildAppCatalog(input: CatalogInput): CatalogApp[] {
  const { filter, live, registry, codeTabs, servicesByTab, columnInfo } = input;
  const out: CatalogApp[] = [];

  const columns: CodeTab[] = filter.allColumns
    ? codeTabs.filter((t) => !t.customAppId)
    : filter.tabId
      ? codeTabs.filter((t) => t.id === filter.tabId)
      : [];

  // Column-scoped apps, per relevant column.
  for (const tab of columns) {
    const services = servicesByTab[tab.id];
    for (const app of registry) {
      if (!app.columnScoped || app.id === 'chat') {
        // `chat` is the agent's own conversation surface, not a drivable app.
        continue;
      }
      if (!descriptorAvailable(app, services)) {
        continue; // hidden in this column, exactly as the dock hides it
      }
      const handleId = makeAppHandleId('column', app.id, tab.id);
      const liveEntry = live[handleId];
      out.push({
        id: app.id,
        handleId,
        kind: app.kind,
        scope: 'column',
        label: app.label,
        controllable: liveEntry ? liveEntry.controllable : isControllableKind(app.kind),
        running: !!liveEntry,
        available: true,
        url: liveEntry?.url,
        title: liveEntry?.title,
        tabId: tab.id,
        ...(filter.allColumns ? { column: { tabId: tab.id, ...columnInfo(tab.id) } } : {}),
      });
    }
  }

  // Global dock apps.
  if (filter.allowGlobal || filter.allColumns) {
    for (const app of registry) {
      if (app.columnScoped) {
        continue;
      }
      const handleId = makeAppHandleId('global', app.id);
      const liveEntry = live[handleId];
      out.push({
        id: app.id,
        handleId,
        kind: app.kind,
        scope: 'global',
        label: app.label,
        controllable: liveEntry ? liveEntry.controllable : isControllableKind(app.kind),
        running: !!liveEntry,
        available: true,
        url: liveEntry?.url,
        title: liveEntry?.title,
      });
    }
    // Live global entries the registry doesn't cover (e.g. the shell's global
    // dock browser, `global:browser`).
    for (const entry of Object.values(live)) {
      if (entry.scope !== 'global' || out.some((o) => o.handleId === entry.handleId)) {
        continue;
      }
      out.push({
        id: entry.appId,
        handleId: entry.handleId,
        kind: entry.kind,
        scope: 'global',
        label: entry.label,
        controllable: entry.controllable,
        running: true,
        available: true,
        url: entry.url,
        title: entry.title,
      });
    }
  }

  return out;
}
