/**
 * Renderer-side handler for the launcher-only client tools that the in-process
 * MCP server doesn't cover.
 *
 * Project / ticket / milestone / page / inbox CRUD is served by
 * `omni-projects-mcp` directly to the agent. This file handles only:
 * - escalation / notification channels (`escalate`, `notify`)
 * - supervisor lifecycle (`start_ticket`, `stop_ticket`)
 * - deck UI overlays (`browser_open`, `display_plan`)
 * - app-control + browser-control suites that drive the renderer's webviews
 */

import { listLiveApps, resolveAppHandle } from '@/renderer/features/AppControl/live-registry';
import { requestPlanApproval } from '@/renderer/features/Tickets/plan-approval-bridge';
import { requestPreviewOpen } from '@/renderer/features/Tickets/preview-bridge';
import { ticketApi } from '@/renderer/features/Tickets/state';
import type { ClientToolCallHandler } from '@/renderer/omniagents-ui/App';
import { emitter } from '@/renderer/services/ipc';
import type { AppClickButton, AppConsoleLevel } from '@/shared/app-control-types';
import type { ProjectId, TicketId } from '@/shared/types';

type ClientToolResult = Awaited<ReturnType<ClientToolCallHandler>>;

const ok = (result: Record<string, unknown>): ClientToolResult => ({ ok: true, result });
const err = (message: string): ClientToolResult => ({ ok: true, result: { error: message } });

function handleTicketTools(toolName: string, toolArgs: Record<string, unknown>): ClientToolResult | null {
  switch (toolName) {
    case 'escalate': {
      const message = (toolArgs.message as string) ?? '';
      if (!message) {
        return err('Empty escalation message');
      }
      return ok({ ok: true, message: 'Escalated to human operator' });
    }
    case 'notify': {
      const message = (toolArgs.message as string) ?? '';
      if (!message) {
        return err('Empty notification message');
      }
      return ok({ ok: true, message: 'Notification sent' });
    }
    default:
      return null;
  }
}

/** Supervisor lifecycle — start/stop the autopilot agent on a ticket. */
async function handleProjectTools(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<ClientToolResult | null> {
  switch (toolName) {
    case 'start_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) {
        return err('Missing ticket_id');
      }
      try {
        await ticketApi.startSupervisor(targetId as TicketId);
        return ok({ ok: true });
      } catch (e) {
        return err(String(e));
      }
    }
    case 'stop_ticket': {
      const targetId = (toolArgs.ticket_id as string) ?? '';
      if (!targetId) {
        return err('Missing ticket_id');
      }
      try {
        await ticketApi.stopSupervisor(targetId as TicketId);
        return ok({ ok: true });
      } catch (e) {
        return err(String(e));
      }
    }
    default:
      return null;
  }
}
async function handleUITools(
  toolName: string,
  toolArgs: Record<string, unknown>,
  tabId?: string,
): Promise<ClientToolResult | null> {
  switch (toolName) {
    case 'browser_open': {
      const url = (toolArgs.url as string) ?? '';
      if (!url) {
return err('Missing url');
}
      requestPreviewOpen(url, tabId);
      return ok({ ok: true, url });
    }
    case 'display_plan': {
      const title = (toolArgs.title as string) ?? 'Plan';
      const description = toolArgs.description as string | undefined;
      const rawSteps = toolArgs.steps as Array<{ title: string; description?: string }> | undefined;
      const steps = (rawSteps ?? []).map((s) => ({
        title: String(s?.title ?? ''),
        description: typeof s?.description === 'string' ? s.description : undefined,
      }));
      const approved = await requestPlanApproval({ title, description, steps });
      return ok({ approved });
    }
    default:
      return null;
  }
}

/**
 * App-control tools. Dispatches the full `app_*` family — discovery, history,
 * input, snapshot, capture, page primitives (scroll/find/wait/inject_css/etc.),
 * and per-webview state (cookies/storage/network) — against the live webview
 * registry. Enforces scope: column-only for autopilot, column+global otherwise.
 */
async function handleAppControlTools(
  toolName: string,
  toolArgs: Record<string, unknown>,
  filter: { tabId?: string; allowGlobal: boolean },
  currentTicketId?: TicketId,
): Promise<ClientToolResult | null> {
  if (toolName === 'list_apps') {
    const apps = listLiveApps(filter).map((a) => ({
      id: a.appId,
      kind: a.kind,
      scope: a.scope,
      url: a.url ?? null,
      title: a.title ?? null,
      label: a.label,
      controllable: a.controllable,
    }));
    return ok({ apps });
  }

  if (!toolName.startsWith('app_')) {
    return null;
  }

  const appId = (toolArgs.app_id as string | undefined) ?? '';
  if (!appId) {
    return err('Missing app_id — call list_apps first to see available ids.');
  }
  const resolved = resolveAppHandle(appId, filter);
  if (!resolved) {
    return err(`Unknown or out-of-scope app: "${appId}". Call list_apps to see what's available.`);
  }
  if (!resolved.controllable) {
    return err(
      `App "${appId}" (${resolved.kind}) is not a web surface. Only browser/code/desktop/webview apps can be driven.`
    );
  }
  const handleId = resolved.handleId;

  try {
    switch (toolName) {
      case 'app_navigate': {
        const url = (toolArgs.url as string) ?? '';
        if (!url) {
          return err('Missing url');
        }
        await emitter.invoke('app:navigate', handleId, url);
        return ok({ ok: true });
      }
      case 'app_reload':
        await emitter.invoke('app:reload', handleId);
        return ok({ ok: true });
      case 'app_back':
        await emitter.invoke('app:back', handleId);
        return ok({ ok: true });
      case 'app_forward':
        await emitter.invoke('app:forward', handleId);
        return ok({ ok: true });
      case 'app_eval': {
        const code = (toolArgs.code as string) ?? '';
        if (!code) {
          return err('Missing code');
        }
        const value = await emitter.invoke('app:eval', handleId, code);
        return ok({ value: value ?? null });
      }
      case 'app_screenshot': {
        const subdir = currentTicketId ? { artifactsSubdir: currentTicketId } : {};
        if (typeof toolArgs.ref === 'string' && toolArgs.ref) {
          const path = await emitter.invoke('app:element-screenshot', handleId, toolArgs.ref, subdir);
          return ok({ path });
        }
        if (toolArgs.full_page === true) {
          const path = await emitter.invoke('app:full-screenshot', handleId, subdir);
          return ok({ path });
        }
        const path = await emitter.invoke('app:screenshot', handleId, subdir);
        return ok({ path });
      }
      case 'app_console': {
        const level = toolArgs.min_level as AppConsoleLevel | undefined;
        const entries = await emitter.invoke(
          'app:console',
          handleId,
          level ? { minLevel: level } : {}
        );
        return ok({ entries });
      }
      case 'app_snapshot': {
        const tree = await emitter.invoke('app:snapshot', handleId);
        return ok({ snapshot: tree });
      }
      case 'app_snapshot_diff': {
        const diff = await emitter.invoke('app:snapshot-diff', handleId);
        return ok(diff);
      }
      case 'app_click': {
        const ref = (toolArgs.ref as string) ?? '';
        if (!ref) {
          return err('Missing ref — get one from app_snapshot.');
        }
        const button = toolArgs.button as AppClickButton | undefined;
        await emitter.invoke('app:click', handleId, ref, button ? { button } : {});
        return ok({ ok: true });
      }
      case 'app_fill': {
        const ref = (toolArgs.ref as string) ?? '';
        const text = (toolArgs.text as string) ?? '';
        if (!ref) {
          return err('Missing ref');
        }
        await emitter.invoke('app:fill', handleId, ref, text);
        return ok({ ok: true });
      }
      case 'app_type': {
        const text = (toolArgs.text as string) ?? '';
        if (!text) {
          return err('Missing text');
        }
        await emitter.invoke('app:type', handleId, text);
        return ok({ ok: true });
      }
      case 'app_press': {
        const key = (toolArgs.key as string) ?? '';
        if (!key) {
          return err('Missing key');
        }
        await emitter.invoke('app:press', handleId, key);
        return ok({ ok: true });
      }
      case 'app_scroll': {
        const opts = {
          dx: typeof toolArgs.dx === 'number' ? (toolArgs.dx as number) : undefined,
          dy: typeof toolArgs.dy === 'number' ? (toolArgs.dy as number) : undefined,
          toTop: toolArgs.to_top === true,
          toBottom: toolArgs.to_bottom === true,
        };
        await emitter.invoke('app:scroll', handleId, opts);
        return ok({ ok: true });
      }
      case 'app_inject_css': {
        const css = (toolArgs.css as string) ?? '';
        if (!css) {
return err('Missing css');
}
        const key = await emitter.invoke('app:inject-css', handleId, css);
        return ok({ key });
      }
      case 'app_remove_inserted_css': {
        const key = (toolArgs.key as string) ?? '';
        if (!key) {
return err('Missing key');
}
        await emitter.invoke('app:remove-inserted-css', handleId, key);
        return ok({ ok: true });
      }
      case 'app_find_in_page': {
        const query = (toolArgs.query as string) ?? '';
        if (!query) {
return err('Missing query');
}
        const result = await emitter.invoke('app:find', handleId, query, {
          caseSensitive: toolArgs.case_sensitive === true,
          forward: toolArgs.forward !== false,
          findNext: toolArgs.find_next === true,
        });
        return ok({ matches: result.matches, active_ordinal: result.activeOrdinal });
      }
      case 'app_wait_for': {
        try {
          const res = await emitter.invoke('app:wait-for', handleId, {
            selector: typeof toolArgs.selector === 'string' ? (toolArgs.selector as string) : undefined,
            urlIncludes:
              typeof toolArgs.url_includes === 'string' ? (toolArgs.url_includes as string) : undefined,
            networkIdle: toolArgs.network_idle === true,
            timeoutMs: typeof toolArgs.timeout_ms === 'number' ? (toolArgs.timeout_ms as number) : undefined,
          });
          return ok(res);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
      }
      case 'app_scroll_to_ref': {
        const ref = (toolArgs.ref as string) ?? '';
        if (!ref) {
return err('Missing ref');
}
        await emitter.invoke('app:scroll-to-ref', handleId, ref);
        return ok({ ok: true });
      }
      case 'app_pdf': {
        const path = await emitter.invoke(
          'app:pdf',
          handleId,
          {
            ...(currentTicketId ? { artifactsSubdir: currentTicketId } : {}),
            ...(typeof toolArgs.landscape === 'boolean' ? { landscape: toolArgs.landscape as boolean } : {}),
            ...(typeof toolArgs.print_background === 'boolean'
              ? { printBackground: toolArgs.print_background as boolean }
              : {}),
          }
        );
        return ok({ path });
      }
      case 'app_set_viewport': {
        if (toolArgs.clear === true) {
          await emitter.invoke('app:set-viewport', handleId, { clear: true });
          return ok({ ok: true });
        }
        const width = Number(toolArgs.width);
        const height = Number(toolArgs.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          return err('app_set_viewport needs positive `width` + `height`, or `clear: true`.');
        }
        await emitter.invoke('app:set-viewport', handleId, {
          width,
          height,
          ...(typeof toolArgs.device_scale_factor === 'number'
            ? { deviceScaleFactor: toolArgs.device_scale_factor as number }
            : {}),
          ...(typeof toolArgs.mobile === 'boolean' ? { mobile: toolArgs.mobile as boolean } : {}),
        });
        return ok({ ok: true });
      }
      case 'app_set_user_agent': {
        const ua = (toolArgs.user_agent as string) ?? '';
        await emitter.invoke('app:set-user-agent', handleId, ua);
        return ok({ ok: true });
      }
      case 'app_set_zoom': {
        const factor = Number(toolArgs.factor);
        if (!Number.isFinite(factor)) {
return err('Missing numeric factor');
}
        await emitter.invoke('app:set-zoom', handleId, factor);
        return ok({ ok: true });
      }
      case 'app_cookies_get': {
        const cookies = await emitter.invoke('app:cookies-get', handleId, {
          ...(typeof toolArgs.url === 'string' ? { url: toolArgs.url as string } : {}),
          ...(typeof toolArgs.name === 'string' ? { name: toolArgs.name as string } : {}),
          ...(typeof toolArgs.domain === 'string' ? { domain: toolArgs.domain as string } : {}),
          ...(typeof toolArgs.path === 'string' ? { path: toolArgs.path as string } : {}),
        });
        return ok({ cookies });
      }
      case 'app_cookies_set': {
        const url = (toolArgs.url as string) ?? '';
        const name = (toolArgs.name as string) ?? '';
        const value = (toolArgs.value as string) ?? '';
        if (!url || !name) {
return err('Missing url or name');
}
        await emitter.invoke('app:cookies-set', handleId, {
          url,
          name,
          value,
          ...(typeof toolArgs.domain === 'string' ? { domain: toolArgs.domain as string } : {}),
          ...(typeof toolArgs.path === 'string' ? { path: toolArgs.path as string } : {}),
          ...(typeof toolArgs.secure === 'boolean' ? { secure: toolArgs.secure as boolean } : {}),
          ...(typeof toolArgs.http_only === 'boolean' ? { httpOnly: toolArgs.http_only as boolean } : {}),
          ...(typeof toolArgs.expiration_date === 'number'
            ? { expirationDate: toolArgs.expiration_date as number }
            : {}),
          ...(typeof toolArgs.same_site === 'string'
            ? { sameSite: toolArgs.same_site as 'unspecified' | 'no_restriction' | 'lax' | 'strict' }
            : {}),
        });
        return ok({ ok: true });
      }
      case 'app_cookies_clear': {
        const removed = await emitter.invoke('app:cookies-clear', handleId, {
          ...(typeof toolArgs.url === 'string' ? { url: toolArgs.url as string } : {}),
          ...(typeof toolArgs.name === 'string' ? { name: toolArgs.name as string } : {}),
        });
        return ok({ removed });
      }
      case 'app_storage_get': {
        const which = toolArgs.which as 'local' | 'session';
        if (which !== 'local' && which !== 'session') {
return err('which must be "local" or "session"');
}
        const entries = await emitter.invoke('app:storage-get', handleId, which);
        return ok({ entries });
      }
      case 'app_storage_set': {
        const which = toolArgs.which as 'local' | 'session';
        const entries = toolArgs.entries as Record<string, string> | undefined;
        if (which !== 'local' && which !== 'session') {
return err('which must be "local" or "session"');
}
        if (!entries || typeof entries !== 'object') {
return err('Missing entries object');
}
        await emitter.invoke('app:storage-set', handleId, which, entries);
        return ok({ ok: true });
      }
      case 'app_storage_clear': {
        const which = toolArgs.which as 'local' | 'session';
        if (which !== 'local' && which !== 'session') {
return err('which must be "local" or "session"');
}
        await emitter.invoke('app:storage-clear', handleId, which);
        return ok({ ok: true });
      }
      case 'app_network_log': {
        const entries = await emitter.invoke('app:network-log', handleId, {
          ...(typeof toolArgs.limit === 'number' ? { limit: toolArgs.limit as number } : {}),
          ...(typeof toolArgs.since === 'number' ? { since: toolArgs.since as number } : {}),
          ...(typeof toolArgs.url_includes === 'string' ? { urlIncludes: toolArgs.url_includes as string } : {}),
          ...(typeof toolArgs.status_min === 'number' ? { statusMin: toolArgs.status_min as number } : {}),
          ...(toolArgs.clear === true ? { clear: true } : {}),
        });
        return ok({ entries });
      }
      default:
        return null;
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Browser-surface tools. These operate on tabsets/tabs in the BrowserManager
 * directly — no app-control handle required.
 */
async function handleBrowserTools(
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<ClientToolResult | null> {
  try {
    switch (toolName) {
      case 'browser_list_tabsets': {
        const snapshot = await emitter.invoke('browser:get-state');
        const tabsets = Object.values(snapshot.tabsets).map((ts) => ({
          id: ts.id,
          profile_id: ts.profileId,
          active_tab_id: ts.activeTabId,
          tabs: ts.tabs.map((t) => ({
            id: t.id,
            url: t.url,
            title: t.title ?? null,
            pinned: !!t.pinned,
          })),
        }));
        return ok({ tabsets });
      }
      case 'browser_tab_create': {
        const tabsetId = (toolArgs.tabset_id as string) ?? '';
        if (!tabsetId) {
return err('Missing tabset_id');
}
        const tab = await emitter.invoke('browser:tab-create', tabsetId, {
          ...(typeof toolArgs.url === 'string' ? { url: toolArgs.url as string } : {}),
          ...(typeof toolArgs.activate === 'boolean' ? { activate: toolArgs.activate as boolean } : {}),
        });
        return ok({ tab_id: tab.id, url: tab.url });
      }
      case 'browser_tab_close': {
        const tabsetId = (toolArgs.tabset_id as string) ?? '';
        const tabId = (toolArgs.tab_id as string) ?? '';
        if (!tabsetId || !tabId) {
return err('Missing tabset_id or tab_id');
}
        await emitter.invoke('browser:tab-close', tabsetId, tabId);
        return ok({ ok: true });
      }
      case 'browser_tab_activate': {
        const tabsetId = (toolArgs.tabset_id as string) ?? '';
        const tabId = (toolArgs.tab_id as string) ?? '';
        if (!tabsetId || !tabId) {
return err('Missing tabset_id or tab_id');
}
        await emitter.invoke('browser:tab-activate', tabsetId, tabId);
        return ok({ ok: true });
      }
      case 'browser_tab_navigate': {
        const tabsetId = (toolArgs.tabset_id as string) ?? '';
        const tabId = (toolArgs.tab_id as string) ?? '';
        const url = (toolArgs.url as string) ?? '';
        if (!tabsetId || !tabId || !url) {
return err('Missing tabset_id, tab_id, or url');
}
        await emitter.invoke('browser:tab-navigate', tabsetId, tabId, url);
        return ok({ ok: true });
      }
      default:
        return null;
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Build a ClientToolCallHandler for interactive sessions.
 * All tools are available. When ticketId/projectId are provided,
 * ticket-scoped tools (move_ticket, escalate, notify) use that context.
 *
 * `allowGlobal` (default true) controls whether the caller can drive the
 * global dock apps via `app_*` tools. Autopilot sessions pass `false`.
 */
export function buildClientToolHandler(opts?: {
  ticketId?: TicketId;
  projectId?: ProjectId;
  tabId?: string;
  allowGlobal?: boolean;
}): ClientToolCallHandler {
  const allowGlobal = opts?.allowGlobal ?? true;
  return async (toolName: string, toolArgs: Record<string, unknown>) => {
    const ticketResult = handleTicketTools(toolName, toolArgs);
    if (ticketResult) {
      return ticketResult;
    }

    const projectResult = await handleProjectTools(toolName, toolArgs);
    if (projectResult) {
      return projectResult;
    }

    const uiResult = await handleUITools(toolName, toolArgs, opts?.tabId);
    if (uiResult) {
      return uiResult;
    }

    const browserResult = await handleBrowserTools(toolName, toolArgs);
    if (browserResult) {
      return browserResult;
    }

    const appResult = await handleAppControlTools(
      toolName,
      toolArgs,
      { tabId: opts?.tabId, allowGlobal },
      opts?.ticketId,
    );
    if (appResult) {
      return appResult;
    }

    return err(`Unknown tool: ${toolName}`);
  };
}
