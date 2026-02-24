import { objectEquals } from '@observ33r/object-equals';
import { Terminal } from '@xterm/xterm';
import { atom } from 'nanostores';

import { DEFAULT_XTERM_OPTIONS, STATUS_POLL_INTERVAL_MS } from '@/renderer/constants';
import { emitter, ipc } from '@/renderer/services/ipc';
import type { ChatProcessStatus, WithTimestamp } from '@/shared/types';

export const $chatProcessStatus = atom<WithTimestamp<ChatProcessStatus>>({
  type: 'uninitialized',
  timestamp: Date.now(),
});

export const $chatProcessXTerm = atom<Terminal | null>(null);
const chatTerminalSubscriptions = new Set<() => void>();

const initializeChatTerminal = (): Terminal => {
  let xterm = $chatProcessXTerm.get();

  if (xterm) {
    return xterm;
  }

  xterm = new Terminal({ ...DEFAULT_XTERM_OPTIONS, disableStdin: true });

  chatTerminalSubscriptions.add(
    ipc.on('chat-process:raw-output', (_, data) => {
      xterm.write(data);
    })
  );

  $chatProcessXTerm.set(xterm);
  return xterm;
};

const teardownChatTerminal = () => {
  for (const unsubscribe of chatTerminalSubscriptions) {
    unsubscribe();
  }
  chatTerminalSubscriptions.clear();

  const xterm = $chatProcessXTerm.get();
  if (!xterm) {
    return;
  }
  xterm.dispose();
  $chatProcessXTerm.set(null);
};

export const chatApi = {
  start: (arg: { workspaceDir: string }) => {
    initializeChatTerminal();
    emitter.invoke('chat-process:start', arg);
  },
  stop: async () => {
    await emitter.invoke('chat-process:stop');
    teardownChatTerminal();
  },
};

const listen = () => {
  ipc.on('chat-process:status', (_, status) => {
    $chatProcessStatus.set(status);
    if (status.type === 'exited') {
      teardownChatTerminal();
    }
  });

  const pollChat = async () => {
    const oldStatus = $chatProcessStatus.get();
    const newStatus = await emitter.invoke('chat-process:get-status');
    if (objectEquals(oldStatus, newStatus)) {
      return;
    }
    $chatProcessStatus.set(newStatus);
  };

  setInterval(pollChat, STATUS_POLL_INTERVAL_MS);
};

listen();
