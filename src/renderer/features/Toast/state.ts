import { atom } from 'nanostores';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export type ToastAction = { label: string; onClick: () => void };

export type Toast = {
  id: string;
  level: ToastLevel;
  title: string;
  description?: string;
  /** When present, the toast shows a Copy button that writes this text to the clipboard. */
  copyText?: string;
  /** When present, the toast shows this action button (dismisses on click). */
  action?: ToastAction;
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

type ToastOpts = { copyText?: string; durationMs?: number; action?: ToastAction };

const opted = (opts: ToastOpts) => ({ copyText: opts.copyText, action: opts.action });

export const toast = {
  info: (title: string, description?: string, opts: ToastOpts = {}) =>
    addToast({ level: 'info', title, description, ...opted(opts), durationMs: opts.durationMs ?? 5000 }),
  success: (title: string, description?: string, opts: ToastOpts = {}) =>
    addToast({ level: 'success', title, description, ...opted(opts), durationMs: opts.durationMs ?? 5000 }),
  warning: (title: string, description?: string, opts: ToastOpts = {}) =>
    addToast({ level: 'warning', title, description, ...opted(opts), durationMs: opts.durationMs ?? 7000 }),
  error: (title: string, description?: string, opts: ToastOpts = {}) =>
    addToast({ level: 'error', title, description, ...opted(opts), durationMs: opts.durationMs ?? 10000 }),
};
