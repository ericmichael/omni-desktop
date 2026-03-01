import { ipc } from '@/renderer/services/ipc';

ipc.on('dev:console-log', (data) => {
  console.log(data);
});
