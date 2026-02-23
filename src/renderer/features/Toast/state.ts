import { atom } from 'nanostores';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export type Toast = {
  id: string;
  level: ToastLevel;
  title: string;
  description?: string;
  durationMs: number;
};

let nextId = 0;

export const $toasts = atom<Toast[]>([]);

export const addToast = (toast: Omit<Toast, 'id'>): string => {
  const id = `toast-${++nextId}`;
  $toasts.set([...$toasts.get(), { ...toast, id }]);
  return id;
};

export const removeToast = (id: string): void => {
  $toasts.set($toasts.get().filter((t) => t.id !== id));
};

export const toast = {
  info: (title: string, description?: string, durationMs = 5000) =>
    addToast({ level: 'info', title, description, durationMs }),
  success: (title: string, description?: string, durationMs = 5000) =>
    addToast({ level: 'success', title, description, durationMs }),
  warning: (title: string, description?: string, durationMs = 7000) =>
    addToast({ level: 'warning', title, description, durationMs }),
  error: (title: string, description?: string, durationMs = 10000) =>
    addToast({ level: 'error', title, description, durationMs }),
};
