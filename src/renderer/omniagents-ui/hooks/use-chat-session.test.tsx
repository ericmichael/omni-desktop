import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';
import { getSessionRegistry } from '@/renderer/omniagents-ui/session/session-registry';
import { deferred, fakeSessionClient, historyPage } from '@/renderer/omniagents-ui/session/session-test-support';

import { useChatSession } from './use-chat-session';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
let value: ReturnType<typeof useChatSession>;
let client: RPCClient;

function Harness({ id }: { id: string }) {
  value = useChatSession(client, id);
  return (
    <div>
      {value.items.map((item, index) => (
        <p key={index}>{item.type === 'chat' ? item.content : item.type}</p>
      ))}
    </div>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  if (client) {
    getSessionRegistry(client).dispose();
  }
  container.remove();
});

describe('session view subscriptions', () => {
  it('changes subscriptions while delayed A history still resolves into A', async () => {
    const setup = fakeSessionClient();
    client = setup.client;
    const historyA = deferred<any>();
    setup.fake.request.mockImplementation(async (method, params) => {
      if (method === 'queue_status') {
        return { run_active: false };
      }
      return params.thread_id === 'A' ? historyA.promise : historyPage('B', 'B history');
    });
    await act(async () => root.render(<Harness id="A" />));
    const a = value.controller;
    let loading!: Promise<string>;
    await act(async () => {
      loading = value.loadSession();
    });
    await act(async () => root.render(<Harness id="B" />));
    await act(async () => {
      await value.loadSession();
    });
    expect(container.textContent).toBe('B history');
    await act(async () => {
      historyA.resolve(historyPage('A', 'A history'));
      await loading;
    });
    expect(container.textContent).toBe('B history');
    expect(a.actor.getSnapshot().context.items).toEqual([expect.objectContaining({ content: 'A history' })]);
    await act(async () => root.render(<Harness id="A" />));
    expect(value.controller).toBe(a);
    expect(container.textContent).toBe('A history');
  });

  it('retains an outstanding command through view unmount and shows its result on return', async () => {
    const setup = fakeSessionClient();
    client = setup.client;
    await act(async () => root.render(<Harness id="A" />));
    await act(async () => {
      await value.loadSession();
    });
    const a = value.controller;
    const response = deferred<any>();
    setup.fake.serverCall.mockImplementationOnce(() => response.promise);
    let command!: Promise<unknown>;
    await act(async () => {
      command = a.send('/help');
    });
    await act(async () => root.render(<Harness id="B" />));
    await act(async () => {
      await value.loadSession();
    });
    await act(async () => {
      response.resolve({ message: 'A result' });
      await command;
    });
    expect(container.textContent).not.toContain('A result');
    await act(async () => root.render(<Harness id="A" />));
    expect(container.textContent).toContain('A result');
    expect(setup.fake.unregisterSession).not.toHaveBeenCalled();
    expect(setup.fake.disconnect).not.toHaveBeenCalled();
  });

  it('rejects retargeting a controller instead of mutating its identity', async () => {
    client = fakeSessionClient().client;
    await act(async () => root.render(<Harness id="A" />));
    await expect(value.loadSession('B')).rejects.toThrow('cannot change identity');
    expect(value.actor.getSnapshot().context.sessionId).toBe('A');
  });

  it('shares one actor when two views render the same session', async () => {
    client = fakeSessionClient().client;
    const actors: unknown[] = [];
    function View() {
      const chat = useChatSession(client, 'A');
      actors.push(chat.actor);
      return null;
    }
    await act(async () =>
      root.render(
        <>
          <View />
          <View />
        </>
      )
    );
    expect(actors[0]).toBe(actors[1]);
  });
});
