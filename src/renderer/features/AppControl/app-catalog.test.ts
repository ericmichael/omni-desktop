import { describe, expect, it } from 'vitest';

import { buildAppCatalog, type CatalogInput } from '@/renderer/features/AppControl/app-catalog-core';
import type { LiveAppSnapshot } from '@/shared/app-control-types';
import { makeAppHandleId } from '@/shared/app-control-types';
import { buildAppRegistry } from '@/shared/app-registry';
import type { CodeTab } from '@/shared/types';

const tab = (id: string, extra?: Partial<CodeTab>): CodeTab => ({
  id,
  projectId: null,
  createdAt: 0,
  ...extra,
});

const liveColumn = (tabId: string, appId: string): LiveAppSnapshot => ({
  handleId: makeAppHandleId('column', appId, tabId),
  appId,
  kind: 'builtin-browser',
  scope: 'column',
  tabId,
  label: appId,
  controllable: true,
});

const base = (over: Partial<CatalogInput>): CatalogInput => ({
  filter: { allowGlobal: true },
  live: {},
  registry: buildAppRegistry([]),
  codeTabs: [tab('t1')],
  servicesByTab: {},
  columnInfo: () => ({}),
  ...over,
});

describe('buildAppCatalog', () => {
  it('reports column-scoped apps as available even when none are running', () => {
    const cat = buildAppCatalog(base({ filter: { tabId: 't1', allowGlobal: true } }));
    const terminal = cat.find((a) => a.id === 'terminal' && a.tabId === 't1');
    expect(terminal).toBeDefined();
    expect(terminal!.available).toBe(true);
    expect(terminal!.running).toBe(false);
    expect(terminal!.handleId).toBe('tab-t1:terminal');
  });

  it('excludes the agent chat surface from the catalog', () => {
    const cat = buildAppCatalog(base({ filter: { tabId: 't1', allowGlobal: true } }));
    expect(cat.some((a) => a.id === 'chat')).toBe(false);
  });

  it('hides sandbox apps until the sandbox exposes their service', () => {
    const without = buildAppCatalog(base({ filter: { tabId: 't1', allowGlobal: true } }));
    expect(without.some((a) => a.id === 'code')).toBe(false);
    expect(without.some((a) => a.id === 'desktop')).toBe(false);

    const withSvc = buildAppCatalog(
      base({
        filter: { tabId: 't1', allowGlobal: true },
        servicesByTab: { t1: { code_server: 'http://cs', vnc: 'http://vnc' } },
      })
    );
    expect(withSvc.some((a) => a.id === 'code')).toBe(true);
    expect(withSvc.some((a) => a.id === 'desktop')).toBe(true);
  });

  it('flags running apps from the live registry', () => {
    const cat = buildAppCatalog(
      base({
        filter: { tabId: 't1', allowGlobal: true },
        live: { 'tab-t1:browser': liveColumn('t1', 'browser') },
      })
    );
    const browser = cat.find((a) => a.id === 'browser' && a.tabId === 't1');
    expect(browser!.running).toBe(true);
  });

  it('column caller does not see other columns', () => {
    const cat = buildAppCatalog(base({ filter: { tabId: 't1', allowGlobal: true }, codeTabs: [tab('t1'), tab('t2')] }));
    expect(cat.some((a) => a.tabId === 't2')).toBe(false);
  });

  it('superuser sees every column, tagged with column context', () => {
    const cat = buildAppCatalog(
      base({
        filter: { allowGlobal: true, allColumns: true },
        codeTabs: [tab('t1', { sessionId: 's1' }), tab('t2', { sessionId: 's2' })],
        columnInfo: (id) => ({ sessionId: id === 't1' ? 's1' : 's2', project: 'Proj' }),
      })
    );
    const t1Term = cat.find((a) => a.handleId === 'tab-t1:terminal');
    const t2Term = cat.find((a) => a.handleId === 'tab-t2:terminal');
    expect(t1Term?.column).toEqual({ tabId: 't1', sessionId: 's1', project: 'Proj' });
    expect(t2Term?.column).toEqual({ tabId: 't2', sessionId: 's2', project: 'Proj' });
  });

  it('superuser skips standalone app columns when enumerating dock apps', () => {
    const cat = buildAppCatalog(
      base({
        filter: { allowGlobal: true, allColumns: true },
        codeTabs: [tab('t1'), tab('app-col', { customAppId: 'marimo' })],
      })
    );
    expect(cat.some((a) => a.tabId === 'app-col')).toBe(false);
  });

  it('lists global custom apps as available, and surfaces live global entries the registry lacks', () => {
    const cat = buildAppCatalog(
      base({
        filter: { allowGlobal: true },
        registry: buildAppRegistry([
          { id: 'dash', label: 'Dash', icon: 'x', url: 'http://dash', order: 99, columnScoped: false },
        ]),
        live: {
          'global:browser': {
            handleId: 'global:browser',
            appId: 'browser',
            kind: 'builtin-browser',
            scope: 'global',
            label: 'Browser',
            controllable: true,
          },
        },
      })
    );
    const dash = cat.find((a) => a.id === 'dash');
    expect(dash?.scope).toBe('global');
    expect(dash?.available).toBe(true);
    expect(dash?.running).toBe(false);
    const globalBrowser = cat.find((a) => a.handleId === 'global:browser');
    expect(globalBrowser?.running).toBe(true);
  });

  it('omits global apps when allowGlobal is false (autopilot)', () => {
    const cat = buildAppCatalog(
      base({
        filter: { tabId: 't1', allowGlobal: false },
        registry: buildAppRegistry([
          { id: 'dash', label: 'Dash', icon: 'x', url: 'http://dash', order: 99, columnScoped: false },
        ]),
      })
    );
    expect(cat.some((a) => a.scope === 'global')).toBe(false);
  });
});
