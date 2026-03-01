import { addToast } from '@/renderer/features/Toast/state';
import { ipc } from '@/renderer/services/ipc';

const DURATION_MAP = {
  info: 5000,
  success: 5000,
  warning: 7000,
  error: 10000,
} as const;

ipc.on('toast:show', (payload) => {
  addToast({
    level: payload.level,
    title: payload.title,
    description: payload.description,
    durationMs: DURATION_MAP[payload.level],
  });
});
