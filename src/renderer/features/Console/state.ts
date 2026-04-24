import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { atom, computed } from 'nanostores';

import { DEFAULT_XTERM_OPTIONS } from '@/renderer/constants';
import { emitter, ipc } from '@/renderer/services/ipc';

type BaseXtermState = {
  id: string;
  tabId: string;
  xterm: Terminal;
  fitAddon: FitAddon;
};

export type TerminalState =
  | (BaseXtermState & {
      isRunning: true;
    })
  | (BaseXtermState & {
      isRunning: false;
      exitCode: number;
    });

export const $terminalsByTab = atom<Record<string, TerminalState[]>>({});
export const $activeTerminalIdByTab = atom<Record<string, string | null>>({});

export const terminalsForTab = (tabId: string) => computed($terminalsByTab, (map) => map[tabId] ?? []);
export const activeTerminalIdForTab = (tabId: string) =>
  computed($activeTerminalIdByTab, (map) => map[tabId] ?? null);

// Track hydration per tab so we don't double-fetch if multiple components
// mount for the same column.
const hydratedTabs = new Set<string>();
const pendingHydrations = new Map<string, Promise<void>>();

/**
 * Pull the list of terminals owned by `tabId` from the main process and build
 * xterm instances for any that don't already exist in renderer state.
 *
 * Non-destructive: terminals that the renderer already tracks (because the user
 * just created them via `createTerminal`) are kept as-is — we never replace an
 * already-open xterm instance with a fresh one.
 *
 * Idempotent: safe to call multiple times; later callers await the in-flight
 * fetch or return immediately if the tab has already been hydrated.
 */
export const hydrateTerminalsForTab = async (tabId: string): Promise<void> => {
  if (hydratedTabs.has(tabId)) {
return;
}
  const pending = pendingHydrations.get(tabId);
  if (pending) {
return pending;
}

  const promise = (async () => {
    const ids = await emitter.invoke('terminal:list', tabId);
    const existing = $terminalsByTab.get()[tabId] ?? [];
    const existingIds = new Set(existing.map((t) => t.id));
    const missing = ids.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      const added = missing.map((id) => buildTerminalState(tabId, id));
      setTerminalsForTab(tabId, [...existing, ...added]);
      if (($activeTerminalIdByTab.get()[tabId] ?? null) === null) {
        setActiveTerminal(tabId, added[0]!.id);
      }
    }
    hydratedTabs.add(tabId);
  })();
  pendingHydrations.set(tabId, promise);
  try {
    await promise;
  } finally {
    pendingHydrations.delete(tabId);
  }
};

/**
 * On first visit to a tab's terminal surface, hydrate from the backend and —
 * if nothing came back — create one fresh terminal so the user lands in a
 * working shell instead of an empty panel. On subsequent visits (already
 * hydrated), do nothing: if the user destroyed everything on purpose, leave
 * the panel empty until they click `+`.
 */
export const ensureTerminalForTab = async (tabId: string, cwd?: string): Promise<void> => {
  const firstVisit = !hydratedTabs.has(tabId) && !pendingHydrations.has(tabId);
  await hydrateTerminalsForTab(tabId);
  if (!firstVisit) {
return;
}
  const list = $terminalsByTab.get()[tabId] ?? [];
  if (list.length === 0) {
    await createTerminal(tabId, cwd);
  }
};

export const createTerminal = async (tabId: string, cwd?: string): Promise<string> => {
  const id = await emitter.invoke('terminal:create', tabId, cwd);
  const terminal = buildTerminalState(tabId, id);
  const existing = $terminalsByTab.get()[tabId] ?? [];
  setTerminalsForTab(tabId, [...existing, terminal]);
  setActiveTerminal(tabId, id);
  return id;
};

export const destroyTerminal = async (tabId: string, id?: string): Promise<void> => {
  const targetId = id ?? $activeTerminalIdByTab.get()[tabId] ?? null;
  if (!targetId) {
return;
}

  const list = $terminalsByTab.get()[tabId] ?? [];
  const target = list.find((t) => t.id === targetId);
  if (!target) {
return;
}

  await emitter.invoke('terminal:dispose', targetId);
  target.xterm.dispose();

  const remaining = list.filter((t) => t.id !== targetId);
  setTerminalsForTab(tabId, remaining);

  if ($activeTerminalIdByTab.get()[tabId] === targetId) {
    setActiveTerminal(tabId, remaining.length > 0 ? remaining[remaining.length - 1]!.id : null);
  }
};

export const destroyAllTerminalsForTab = async (tabId: string): Promise<void> => {
  const list = $terminalsByTab.get()[tabId] ?? [];
  if (list.length === 0) {
    hydratedTabs.delete(tabId);
    return;
  }

  await emitter.invoke('terminal:dispose-all-for-tab', tabId);
  for (const t of list) {
    t.xterm.dispose();
  }

  const nextTerminals = { ...$terminalsByTab.get() };
  delete nextTerminals[tabId];
  $terminalsByTab.set(nextTerminals);

  const nextActive = { ...$activeTerminalIdByTab.get() };
  delete nextActive[tabId];
  $activeTerminalIdByTab.set(nextActive);

  hydratedTabs.delete(tabId);
};

export const setActiveTerminal = (tabId: string, id: string | null): void => {
  const current = $activeTerminalIdByTab.get();
  if (current[tabId] === id) {
return;
}
  $activeTerminalIdByTab.set({ ...current, [tabId]: id });
};

const setTerminalsForTab = (tabId: string, terminals: TerminalState[]): void => {
  $terminalsByTab.set({ ...$terminalsByTab.get(), [tabId]: terminals });
};

const buildTerminalState = (tabId: string, id: string): TerminalState => {
  const xterm = new Terminal({ ...DEFAULT_XTERM_OPTIONS, cursorBlink: true });
  xterm.onData((data) => {
    emitter.invoke('terminal:write', id, data);
  });
  xterm.onResize(({ cols, rows }) => {
    emitter.invoke('terminal:resize', id, cols, rows);
  });

  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);

  return {
    id,
    tabId,
    isRunning: true,
    xterm,
    fitAddon,
  };
};

const findTerminal = (tabId: string, id: string): TerminalState | null => {
  const list = $terminalsByTab.get()[tabId] ?? [];
  return list.find((t) => t.id === id) ?? null;
};

const updateTerminal = (
  tabId: string,
  id: string,
  patch: Partial<BaseXtermState> & { isRunning?: boolean; exitCode?: number }
): void => {
  const list = $terminalsByTab.get()[tabId] ?? [];
  const next = list.map((t) => (t.id === id ? ({ ...t, ...patch } as TerminalState) : t));
  setTerminalsForTab(tabId, next);
};

ipc.on('terminal:exited', (tabId, id, exitCode) => {
  const terminal = findTerminal(tabId, id);
  if (!terminal) {
return;
}
  terminal.xterm.options.disableStdin = true;
  updateTerminal(tabId, id, { isRunning: false, exitCode });
});

ipc.on('terminal:output', (tabId, id, data) => {
  const terminal = findTerminal(tabId, id);
  if (!terminal) {
return;
}
  terminal.xterm.write(data);
});
