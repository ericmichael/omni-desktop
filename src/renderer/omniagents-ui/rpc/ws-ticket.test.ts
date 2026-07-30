import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchWsTicket, ticketPathFor, withConnectTicket } from '@/renderer/omniagents-ui/rpc/ws-ticket';

const mockFetch = (response: { ok: boolean; status?: number; body?: unknown }) => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body ?? {},
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ticketPathFor', () => {
  it('maps every ws surface to the server ticket endpoint, preserving proxy prefixes', () => {
    expect(ticketPathFor('/ws')).toBe('/auth/ws-ticket');
    expect(ticketPathFor('/ws/realtime')).toBe('/auth/ws-ticket');
    expect(ticketPathFor('/ws/terminal')).toBe('/auth/ws-ticket');
    expect(ticketPathFor('/proxy/chat-1/ws')).toBe('/proxy/chat-1/auth/ws-ticket');
    expect(ticketPathFor('/proxy/chat-1/ws/terminal')).toBe('/proxy/chat-1/auth/ws-ticket');
    expect(ticketPathFor('/proxy/local/m1/s1/ws/realtime')).toBe('/proxy/local/m1/s1/auth/ws-ticket');
  });
});

describe('fetchWsTicket', () => {
  it('POSTs the token as an Authorization header to the http(s) ticket endpoint', async () => {
    const fetchMock = mockFetch({ ok: true, body: { ticket: 'tick-1' } });
    const ticket = await fetchWsTicket('ws://127.0.0.1:9000/ws', 'secret-token');
    expect(ticket).toBe('tick-1');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9000/auth/ws-ticket', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret-token' },
    });
  });

  it('uses https for wss and strips any query from the ticket URL', async () => {
    const fetchMock = mockFetch({ ok: true, body: { ticket: 'tick-2' } });
    await fetchWsTicket('wss://host.example/proxy/chat-1/ws?theme=dark', 'secret-token');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://host.example/proxy/chat-1/auth/ws-ticket');
  });

  it('throws on a non-ok response and on a missing ticket', async () => {
    mockFetch({ ok: false, status: 401 });
    await expect(fetchWsTicket('ws://127.0.0.1:9000/ws', 't')).rejects.toThrow('Authentication failed (401)');
    mockFetch({ ok: true, body: {} });
    await expect(fetchWsTicket('ws://127.0.0.1:9000/ws', 't')).rejects.toThrow('no ticket issued');
  });
});

describe('withConnectTicket', () => {
  it('returns the URL unchanged when no token is configured (unauthenticated server)', async () => {
    const fetchMock = mockFetch({ ok: true, body: { ticket: 'unused' } });
    expect(await withConnectTicket('ws://127.0.0.1:9000/ws')).toBe('ws://127.0.0.1:9000/ws');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('appends only the one-time ticket to the dial URL — never the token', async () => {
    mockFetch({ ok: true, body: { ticket: 'tick-3' } });
    const url = await withConnectTicket('ws://127.0.0.1:9000/ws', 'secret-token');
    expect(url).toBe('ws://127.0.0.1:9000/ws?ticket=tick-3');
    expect(url).not.toContain('secret-token');
    expect(url).not.toContain('token=secret');
  });
});
