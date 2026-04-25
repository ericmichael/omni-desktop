/**
 * Renderer-side handler for the launcher-only client tools that the in-process
 * MCP server doesn't cover. Project / ticket / milestone / page / inbox CRUD
 * is served by `omni-projects-mcp` directly; this file handles UI escalations
 * (`escalate`, `notify`), supervisor lifecycle (`start_ticket`, `stop_ticket`),
 * the deck UI overlays (`open_preview`, `display_plan`), and the
 * renderer-driven app-control suite.
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

function handleTicketTools(
  toolName: string,
  toolArgs: Record<string, unknown>
): ClientToolResult | null {
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

/** Write-oriented project tools — only available in interactive sessions. */
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
    case 'open_preview': {
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
 * App-control tools. Dispatches list/navigate/snapshot/click/fill/type/press
 * /screenshot/eval/console/reload/back/forward against the live webview
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
        const path = await emitter.invoke(
          'app:screenshot',
          handleId,
          currentTicketId ? { artifactsSubdir: currentTicketId } : {}
        );
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
