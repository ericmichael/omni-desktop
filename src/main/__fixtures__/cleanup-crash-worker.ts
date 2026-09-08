import { existsSync, unlinkSync } from 'node:fs';

import { ChatCleanupRunner } from '@/main/chat-removal';
import { ServerStore } from '@/server/store';
import { applyChatCommand } from '@/shared/chat-commands';

const [file, pauseAt] = process.argv.slice(2);
if (!file) {
  throw new Error('Missing isolated store path');
}
const store = new ServerStore(file);
const checkpoint = async (step: string) => {
  if (pauseAt !== step) {
    return;
  }
  process.send?.({ step });
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
};
if (pauseAt) {
  store.set(applyChatCommand(store.store, { method: 'removeTab', args: ['old-tab'] }).patch);
  await checkpoint('commit');
}
const runner = new ChatCleanupRunner({
  read: () => store.get('chatCleanupJobs') ?? [],
  cleanup: async () => {
    if (existsSync(`${file}.runtime`)) {
      unlinkSync(`${file}.runtime`);
    }
    await checkpoint('stop');
    if (existsSync(`${file}.snapshot`)) {
      unlinkSync(`${file}.snapshot`);
    }
    await checkpoint('delete');
  },
  acknowledge: async (id) => {
    await checkpoint('ack');
    store.set(
      'chatCleanupJobs',
      (store.get('chatCleanupJobs') ?? []).filter((job) => job.id !== id)
    );
  },
});
await runner.drain();
await runner.dispose();
process.send?.({ step: 'done' });
