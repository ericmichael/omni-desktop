import { atom } from 'nanostores';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export type Toast = {
  id: string;
  level: ToastLevel;
  title: string;
  description?: string;
  /** When present, the toast shows a Copy button that writes this text to the clipboard. */
  copyText?: string;
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

type ToastOpts = { copyText?: string; durationMs?: number };

export const toast = {
  info: (title: string, description?: string, opts: ToastOpts = {}) =>
    addToast({ level: 'info', title, description, copyText: opts.copyText, durationMs: opts.durationMs ?? 5000 }),
  success: (title: string, description?: string, opts: ToastOpts = {}) =>
    addToast({ level: 'success', title, description, copyText: opts.copyText, durationMs: opts.durationMs ?? 5000 }),
  warning: (title: string, description?: string, opts: ToastOpts = {}) =>
    addToast({ level: 'warning', title, description, copyText: opts.copyText, durationMs: opts.durationMs ?? 7000 }),
  // Errors default to no auto-dismiss so users have time to read/copy them.
  error: (title: string, description?: string, opts: ToastOpts = {}) =>
    addToast({ level: 'error', title, description, copyText: opts.copyText, durationMs: opts.durationMs ?? 0 }),
};
