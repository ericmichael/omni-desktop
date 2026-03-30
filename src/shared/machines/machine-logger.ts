/**
 * Structured debug logger for XState v5 machine transitions.
 *
 * Usage:
 *   createActor(machine, { inspect: createMachineLogger('rpc', { url }) })
 *   useActorRef(machine, { inspect: createMachineLogger('autoLaunch:code', { tabId }) })
 *
 * Enable in browser console:   localStorage.setItem('debug:machines', '1')
 * Filter by machine:           localStorage.setItem('debug:machines', 'rpc,terminal')
 * Disable:                     localStorage.removeItem('debug:machines')
 *
 * Log format:
 *   [machine:rpc url=ws://localhost:8080] disconnected → connecting  (CONNECT)
 *   [machine:terminal tab=abc123] disconnected → ensuringSession  (CONNECT)  +1204ms
 */
import type { InspectionEvent } from 'xstate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MachineLoggerOptions = {
  /** Key-value pairs to include in every log line for identification. */
  tags?: Record<string, string | number | boolean | null | undefined>;
};

type InspectFn = (event: InspectionEvent) => void;

// ---------------------------------------------------------------------------
// Enabled check
// ---------------------------------------------------------------------------

/** Resolve whether logging is enabled for a given machine name. */
function isEnabled(machineName: string): boolean {
  try {
    const flag =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem('debug:machines')
        : typeof process !== 'undefined'
          ? process.env.DEBUG_MACHINES
          : null;

    if (!flag) return false;
    if (flag === '1' || flag === 'true' || flag === '*') return true;

    // Comma-separated filter: "rpc,terminal"
    const filters = flag.split(',').map((s) => s.trim().toLowerCase());
    const lower = machineName.toLowerCase();
    return filters.some((f) => lower.includes(f));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

function formatTags(tags: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(tags)) {
    if (v == null || v === '') continue;
    parts.push(`${k}=${v}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an XState v5 `inspect` callback that logs transitions.
 *
 * Pass as `{ inspect: createMachineLogger('name', { tags }) }` to
 * `createActor()` or `useActorRef()`.
 *
 * Returns a no-op function when logging is disabled (zero overhead).
 */
export function createMachineLogger(machineName: string, opts?: MachineLoggerOptions): InspectFn {
  // Early exit — return no-op if disabled so there's zero runtime cost
  if (!isEnabled(machineName)) {
    return () => {};
  }

  const tagStr = opts?.tags ? formatTags(opts.tags) : '';
  const prefix = `[machine:${machineName}${tagStr}]`;
  let lastTransitionTime = Date.now();

  return (inspectionEvent: InspectionEvent) => {
    // Re-check on each event so you can toggle at runtime
    if (!isEnabled(machineName)) return;

    if (inspectionEvent.type === '@xstate.snapshot') {
      const { event, snapshot } = inspectionEvent;
      const snap = snapshot as any;

      // Only log actual transitions (skip internal init events)
      if (event.type === 'xstate.init') return;

      const now = Date.now();
      const delta = now - lastTransitionTime;
      lastTransitionTime = now;

      const stateValue = typeof snap.value === 'string' ? snap.value : JSON.stringify(snap.value);
      const deltaStr = delta > 0 ? `  +${delta}ms` : '';

      // Build context summary — pick identifying fields
      const ctx = snap.context;
      const contextParts: string[] = [];
      if (ctx) {
        if (ctx.error) contextParts.push(`error="${ctx.error}"`);
        if (ctx.reconnectAttempt > 0) contextParts.push(`attempt=${ctx.reconnectAttempt}`);
        if (ctx.pendingCount > 0) contextParts.push(`pending=${ctx.pendingCount}`);
        if (ctx.phase) contextParts.push(`phase=${ctx.phase}`);
        if (ctx.exitCode != null) contextParts.push(`exitCode=${ctx.exitCode}`);
      }
      const contextStr = contextParts.length > 0 ? `  {${contextParts.join(', ')}}` : '';

      console.log(`${prefix} → ${stateValue}  (${event.type})${contextStr}${deltaStr}`);
    }

    if (inspectionEvent.type === '@xstate.event') {
      const { event } = inspectionEvent;
      // Log events that carry error payloads at warn level
      if ('error' in event && event.error) {
        console.warn(`${prefix} event ${event.type}: ${event.error}`);
      }
    }
  };
}

/**
 * Create a logger for use in Node/main process (uses process.env instead of localStorage).
 * Same API as createMachineLogger but always checks process.env.DEBUG_MACHINES.
 */
export { createMachineLogger as createMainProcessMachineLogger };
