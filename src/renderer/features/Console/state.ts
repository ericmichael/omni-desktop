import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { atom, computed, onMount, task } from 'nanostores';

import { DEFAULT_XTERM_OPTIONS } from '@/renderer/constants';
import { emitter, ipc } from '@/renderer/services/ipc';

type BaseXtermState = {
  id: string;
  xterm: Terminal;
  fitAddon: FitAddon;
  hasNewOutput: boolean;
};

export type TerminalState =
  | (BaseXtermState & {
      isRunning: true;
    })
  | (BaseXtermState & {
      isRunning: false;
      exitCode: number;
    });

export const $isConsoleOpen = atom(false);
export const $terminals = atom<TerminalState[]>([]);
export const $activeTerminalId = atom<string | null>(null);

export const $activeTerminal = computed([$terminals, $activeTerminalId], (terminals, activeId) => {
  return terminals.find((t) => t.id === activeId) ?? null;
});

export const $terminalHasNewOutput = computed([$terminals], (terminals) => {
  return terminals.some((t) => t.hasNewOutput);
});

// Legacy compat — alias for components that read a single terminal
export const $terminal = $activeTerminal;

$isConsoleOpen.listen((isConsoleOpen) => {
  if (isConsoleOpen) {
    // Clear new-output flags and fit all terminals
    const terminals = $terminals.get();
    const updated = terminals.map((t) => (t.hasNewOutput ? { ...t, hasNewOutput: false } : t));
    if (updated.some((t, i) => t !== terminals[i])) {
      $terminals.set(updated);
    }
    const active = $activeTerminal.get();
    if (active) {
      active.fitAddon.fit();
    }
  }
});

onMount($terminals, () => {
  task(async () => {
    const terminalIds = await emitter.invoke('terminal:list');
    if (terminalIds.length === 0) return;

    const terminals = terminalIds.map((id) => buildTerminalState(id));
    $terminals.set(terminals);
    $activeTerminalId.set(terminals[0]!.id);
  });
});

export const createTerminal = async (cwd?: string) => {
  const id = await emitter.invoke('terminal:create', cwd);
  const terminal = buildTerminalState(id);
  $terminals.set([...$terminals.get(), terminal]);
  $activeTerminalId.set(id);
  return id;
};

export const destroyTerminal = async (id?: string) => {
  const targetId = id ?? $activeTerminalId.get();
  if (!targetId) return;

  const terminals = $terminals.get();
  const target = terminals.find((t) => t.id === targetId);
  if (!target) return;

  await emitter.invoke('terminal:dispose', targetId);
  target.xterm.dispose();

  const remaining = terminals.filter((t) => t.id !== targetId);
  $terminals.set(remaining);

  if ($activeTerminalId.get() === targetId) {
    $activeTerminalId.set(remaining.length > 0 ? remaining[remaining.length - 1]!.id : null);
  }

  if (remaining.length === 0) {
    $isConsoleOpen.set(false);
  }
};

export const destroyAllTerminals = async () => {
  const terminals = $terminals.get();
  await Promise.allSettled(
    terminals.map(async (t) => {
      await emitter.invoke('terminal:dispose', t.id);
      t.xterm.dispose();
    })
  );
  $terminals.set([]);
  $activeTerminalId.set(null);
  $isConsoleOpen.set(false);
};

export const setActiveTerminal = (id: string) => {
  $activeTerminalId.set(id);
};

/** @deprecated Use createTerminal instead */
export const initializeTerminal = async (cwd?: string) => {
  await createTerminal(cwd);
};

const buildTerminalState = (id: string): TerminalState => {
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
    isRunning: true,
    hasNewOutput: false,
    xterm,
    fitAddon,
  };
};

const doWithTerminal = (id: string, fn: (terminal: TerminalState) => void) => {
  const terminals = $terminals.get();
  const terminal = terminals.find((t) => t.id === id);
  if (!terminal) {
    console.warn(`Terminal ${id} not found`);
    return;
  }
  fn(terminal);
};

const updateTerminal = (id: string, patch: Partial<BaseXtermState> & { isRunning?: boolean; exitCode?: number }) => {
  const terminals = $terminals.get();
  $terminals.set(terminals.map((t) => (t.id === id ? { ...t, ...patch } as TerminalState : t)));
};

ipc.on('terminal:exited', (id, exitCode) => {
  doWithTerminal(id, (terminal) => {
    terminal.xterm.options.disableStdin = true;
    updateTerminal(id, { isRunning: false, exitCode, hasNewOutput: !$isConsoleOpen.get() });
  });
});

ipc.on('terminal:output', (id, data) => {
  doWithTerminal(id, (terminal) => {
    terminal.xterm.write(data);
    if (!$isConsoleOpen.get()) {
      updateTerminal(id, { hasNewOutput: true });
    }
  });
});
