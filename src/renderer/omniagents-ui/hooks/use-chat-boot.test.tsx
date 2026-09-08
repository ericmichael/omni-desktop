import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

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
