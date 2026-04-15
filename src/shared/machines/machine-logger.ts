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

    if (!flag) {
return false;
}
    if (flag === '1' || flag === 'true' || flag === '*') {
return true;
}

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
    if (v == null || v === '') {
continue;
}
    parts.push(`${k}=${v}`);
  }
  return parts.length > 0 ? ` ${  parts.join(' ')}` : '';
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
  const verbose = isEnabled(machineName);
  const tagStr = opts?.tags ? formatTags(opts.tags) : '';
  const prefix = `[machine:${machineName}${tagStr}]`;
  let lastTransitionTime = Date.now();

  // Dropped-event detection: XState silently ignores events that no state
  // handles. Compare snapshot identity across @xstate.snapshot events — if
  // neither the state value nor context reference changed, the event was a
  // no-op. Rate-limited so a spammy no-op doesn't drown the console.
  const dropCounts = new Map<string, number>();
  let prevValue: unknown;
  let prevContext: unknown;
  const detectDrops = shouldDetectDrops();
  const warnDrop = (eventType: string) => {
    const count = (dropCounts.get(eventType) ?? 0) + 1;
    dropCounts.set(eventType, count);
    if (count <= 3) {
      console.warn(
        `${prefix} dropped event '${eventType}' — no handler in current state. ` +
          `If this event should always apply, move it to the machine root's on: {}.`,
      );
    } else if (count === 4) {
      console.warn(`${prefix} suppressing further '${eventType}' drop warnings`);
    }
  };

  return (inspectionEvent: InspectionEvent) => {
    if (inspectionEvent.type === '@xstate.snapshot') {
      const { event, snapshot } = inspectionEvent;
      const snap = snapshot as any;

      // Skip synthetic init events
      if (event.type === 'xstate.init') {
        prevValue = snap.value;
        prevContext = snap.context;
        return;
      }

      // Dropped-event detection runs regardless of verbose logging
      if (detectDrops) {
        const sameValue = snap.value === prevValue ||
          (typeof snap.value === 'string' && snap.value === prevValue);
        const sameContext = snap.context === prevContext;
        if (sameValue && sameContext) {
          warnDrop(event.type);
        }
      }
      prevValue = snap.value;
      prevContext = snap.context;

      if (!verbose || !isEnabled(machineName)) {
return;
}

      const now = Date.now();
      const delta = now - lastTransitionTime;
      lastTransitionTime = now;

      const stateValue = typeof snap.value === 'string' ? snap.value : JSON.stringify(snap.value);
      const deltaStr = delta > 0 ? `  +${delta}ms` : '';

      // Build context summary — pick identifying fields
      const ctx = snap.context;
      const contextParts: string[] = [];
      if (ctx) {
        if (ctx.error) {
contextParts.push(`error="${ctx.error}"`);
}
        if (ctx.reconnectAttempt > 0) {
contextParts.push(`attempt=${ctx.reconnectAttempt}`);
}
        if (ctx.pendingCount > 0) {
contextParts.push(`pending=${ctx.pendingCount}`);
}
        if (ctx.phase) {
contextParts.push(`phase=${ctx.phase}`);
}
        if (ctx.exitCode != null) {
contextParts.push(`exitCode=${ctx.exitCode}`);
}
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
 * Whether dropped-event detection should run. Enabled in dev by default
 * (Vite's `import.meta.env.DEV` or `process.env.NODE_ENV !== 'production'`),
 * or explicitly via `localStorage.setItem('debug:machines:drops', '1')`.
 * Explicit `0` disables it even in dev.
 */
function shouldDetectDrops(): boolean {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('debug:machines:drops') : null;
    if (ls === '0' || ls === 'false') {
return false;
}
    if (ls === '1' || ls === 'true') {
return true;
}
    // Default: on in dev, off in prod
    const viteEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (viteEnv && typeof viteEnv.DEV === 'boolean') {
return viteEnv.DEV;
}
    if (typeof process !== 'undefined' && process.env) {
      return process.env.NODE_ENV !== 'production';
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Create a logger for use in Node/main process (uses process.env instead of localStorage).
 * Same API as createMachineLogger but always checks process.env.DEBUG_MACHINES.
 */
export { createMachineLogger as createMainProcessMachineLogger };
