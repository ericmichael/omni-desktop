import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAutoRetry } from '@/renderer/hooks/use-auto-retry';

import { useChatBoot, type UseChatBootOptions } from './use-chat-boot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('chat boot connection retry', () => {
  it('does not replay the old permanent error into the new connection attempt', () => {
    const listeners = new Set<() => void>();
    let snapshot = { value: 'disconnected', context: { permanent: false, error: '' } };
    const connect = vi.fn(() => {
      snapshot = { value: 'connecting', context: { permanent: false, error: '' } };
      listeners.forEach((listener) => listener());
      return new Promise<void>(() => {});
    });
    const client = {
      isConnected: false,
      connect,
      actor: {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return { unsubscribe: () => listeners.delete(listener) };
        },
      },
    };
    let value!: ReturnType<typeof useChatBoot>;
    const options = {
      client,
      chatSession: {},
      sessionId: undefined,
    } as unknown as UseChatBootOptions;
    function Harness() {
      value = useChatBoot(options);
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<Harness />));
      act(() => {
        snapshot = { value: 'disconnected', context: { permanent: true, error: 'Old version mismatch' } };
        listeners.forEach((listener) => listener());
      });
      expect(value.phase).toBe('connectionError');
      act(() => value.retry());
      expect(value.phase).toBe('awaitingConnection');
      expect(value.error).toBeNull();
      expect(snapshot.value).toBe('connecting');
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('chat boot automatic recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-dials on its own after a permanent connection failure, on a backoff', () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    let snapshot = { value: 'disconnected', context: { permanent: false, error: '' } };
    const notify = () => listeners.forEach((listener) => listener());
    const connect = vi.fn(() => {
      snapshot = { value: 'connecting', context: { permanent: false, error: '' } };
      notify();
      return new Promise<void>(() => {});
    });
    const fail = () => {
      snapshot = { value: 'disconnected', context: { permanent: true, error: 'Old version mismatch' } };
      notify();
    };
    const client = {
      isConnected: false,
      connect,
      actor: {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return { unsubscribe: () => listeners.delete(listener) };
        },
      },
    };
    let value!: ReturnType<typeof useChatBoot>;
    const options = { client, chatSession: {}, sessionId: undefined } as unknown as UseChatBootOptions;
    function Harness() {
      value = useChatBoot(options);
      const failing =
        value.phase === 'connectionError' || value.phase === 'bootstrapError' || value.phase === 'sessionError';
      useAutoRetry({ failing, healthy: value.ready, retry: value.retry });
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<Harness />));
      act(fail);
      expect(value.phase).toBe('connectionError');
      const dials = connect.mock.calls.length;

      // Nothing happens before the first backoff step, then a fresh dial
      // with no user action.
      act(() => vi.advanceTimersByTime(1499));
      expect(value.phase).toBe('connectionError');
      expect(connect.mock.calls.length).toBe(dials);
      act(() => vi.advanceTimersByTime(1));
      expect(value.phase).toBe('awaitingConnection');
      expect(value.error).toBeNull();
      expect(connect.mock.calls.length).toBeGreaterThan(dials);

      // A second permanent failure waits for the next, longer step.
      act(fail);
      expect(value.phase).toBe('connectionError');
      const dialsAfterFirstRetry = connect.mock.calls.length;
      act(() => vi.advanceTimersByTime(2999));
      expect(connect.mock.calls.length).toBe(dialsAfterFirstRetry);
      act(() => vi.advanceTimersByTime(1));
      expect(value.phase).toBe('awaitingConnection');
      expect(connect.mock.calls.length).toBeGreaterThan(dialsAfterFirstRetry);
    } finally {
      act(() => root.unmount());
    }
  });
});
