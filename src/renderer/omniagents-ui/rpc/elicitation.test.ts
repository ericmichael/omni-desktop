import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElicitationResponseParams } from '@/generated/omniagents-gui-v1/gui-v1';

import {
  decodeElicitationRequested,
  decodeElicitationResolved,
  ElicitationQueue,
  type ElicitationQueueEvent,
  type ElicitationRpcTransport,
  ElicitationValidationError,
  isDefaultRenderableElicitation,
  unsupportedByClientResponse,
  validateElicitationResponse,
} from './elicitation';

function requested(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    elicitation_id: 'elc_1',
    kind: 'question',
    message: 'What should I call it?',
    session_id: 'sess_1',
    seq: 2,
    stream_id: 'stream_1',
    ...overrides,
  };
}

function transportWith(
  implementation: (params: ElicitationResponseParams) => Promise<Record<string, unknown>> = async () => ({
    elicitation_id: 'elc_1',
    status: 'accepted',
  })
): ElicitationRpcTransport & { calls: ElicitationResponseParams[] } {
  const calls: ElicitationResponseParams[] = [];
  return {
    calls,
    async request(method, params) {
      expect(method).toBe('elicitation_response');
      calls.push(params);
      return implementation(params);
    },
  };
}

describe('elicitation runtime decoding', () => {
  it('models all five prompt kinds', () => {
    expect(decodeElicitationRequested(requested())).toMatchObject({ kind: 'question', sensitive: true });
    expect(decodeElicitationRequested(requested({ kind: 'confirm' }))).toMatchObject({ kind: 'confirm' });
    expect(
      decodeElicitationRequested(
        requested({ kind: 'select', options: ['fast', { value: 'safe', label: 'Safe', description: 'Slower' }] })
      )
    ).toMatchObject({
      kind: 'select',
      options: [
        { value: 'fast', label: 'fast' },
        { value: 'safe', label: 'Safe', description: 'Slower' },
      ],
    });
    expect(
      decodeElicitationRequested(
        requested({ kind: 'form', input_schema: { type: 'object', properties: { name: { type: 'string' } } } })
      )
    ).toMatchObject({ kind: 'form', inputSchema: { type: 'object' } });
    expect(decodeElicitationRequested(requested({ kind: 'url', url: 'https://example.com/login' }))).toMatchObject({
      kind: 'url',
      url: 'https://example.com/login',
    });
  });

  it('defaults to sensitive/non-persisted and honors explicit persistence', () => {
    expect(decodeElicitationRequested(requested())).toMatchObject({ persistResponse: false, sensitive: true });
    expect(decodeElicitationRequested(requested({ persist_response: true }))).toMatchObject({
      persistResponse: true,
      sensitive: false,
    });
  });

  it('rejects unsafe URLs and malformed select options with a correlated id', () => {
    expect(() => decodeElicitationRequested(requested({ kind: 'url', url: 'javascript:alert(1)' }))).toThrow(
      expect.objectContaining({ elicitationId: 'elc_1' })
    );
    expect(() => decodeElicitationRequested(requested({ kind: 'select', options: [] }))).toThrow(
      expect.objectContaining({ elicitationId: 'elc_1' })
    );
  });

  it('decodes terminal resolution metadata', () => {
    expect(
      decodeElicitationResolved({
        elicitation_id: 'elc_1',
        status: 'server_restart',
        session_id: 'sess_1',
        reason: 'process died',
      })
    ).toEqual({
      elicitationId: 'elc_1',
      status: 'server_restart',
      sessionId: 'sess_1',
      reason: 'process died',
    });
  });
});

describe('elicitation support and validation', () => {
  it('constructs the required unsupported-client decline', () => {
    expect(unsupportedByClientResponse('elc_1')).toEqual({
      elicitation_id: 'elc_1',
      action: 'decline',
      reason: 'unsupported_by_client',
    });
  });

  it('supports flat primitive forms and conservatively rejects complex schemas', () => {
    const flat = decodeElicitationRequested(
      requested({ kind: 'form', input_schema: { type: 'object', properties: { port: { type: 'integer' } } } })
    );
    const nested = decodeElicitationRequested(
      requested({ kind: 'form', input_schema: { type: 'object', properties: { auth: { type: 'object' } } } })
    );
    const composed = decodeElicitationRequested(
      requested({ kind: 'form', input_schema: { type: 'object', properties: {}, oneOf: [{ required: ['a'] }] } })
    );
    expect(isDefaultRenderableElicitation(flat)).toBe(true);
    expect(isDefaultRenderableElicitation(nested)).toBe(false);
    expect(isDefaultRenderableElicitation(composed)).toBe(false);
  });

  it('validates the response convention for every kind', () => {
    const question = decodeElicitationRequested(requested());
    const confirm = decodeElicitationRequested(requested({ kind: 'confirm' }));
    const select = decodeElicitationRequested(requested({ kind: 'select', options: ['a', 'b'] }));
    const form = decodeElicitationRequested(
      requested({
        kind: 'form',
        input_schema: {
          type: 'object',
          required: ['host'],
          additionalProperties: false,
          properties: { host: { type: 'string', minLength: 2 }, port: { type: 'integer', minimum: 1 } },
        },
      })
    );
    const url = decodeElicitationRequested(requested({ kind: 'url', url: 'https://example.com' }));

    expect(validateElicitationResponse(question, { action: 'accept', value: { text: 'name' } })).toEqual([]);
    expect(validateElicitationResponse(question, { action: 'accept', value: { text: '' } })).not.toEqual([]);
    expect(validateElicitationResponse(confirm, { action: 'accept', value: { confirmed: false } })).toEqual([]);
    expect(validateElicitationResponse(select, { action: 'accept', value: { selected: ['b'] } })).toEqual([]);
    expect(validateElicitationResponse(select, { action: 'accept', value: { selected: ['c'] } })).not.toEqual([]);
    expect(validateElicitationResponse(form, { action: 'accept', value: { host: 'db', port: 5432 } })).toEqual([]);
    expect(validateElicitationResponse(form, { action: 'accept', value: { host: 'x', extra: true } })).toEqual([
      'value.host must contain at least 2 characters',
      'value.extra is not allowed',
    ]);
    expect(validateElicitationResponse(url, { action: 'accept', value: { completed: true } })).toEqual([]);
    expect(validateElicitationResponse(url, { action: 'accept' })).toEqual([]);
  });
});

describe('ElicitationQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('indexes pending prompts by request and session and ignores stale replay', async () => {
    const queue = new ElicitationQueue(transportWith());
    await queue.receiveRequested(requested({ seq: 5, message: 'new' }));
    await queue.receiveRequested(requested({ seq: 4, message: 'old' }));
    await queue.receiveRequested(requested({ elicitation_id: 'elc_2', session_id: 'sess_2' }));

    expect(queue.get('elc_1')?.message).toBe('new');
    expect(queue.list('sess_1').map((item) => item.elicitationId)).toEqual(['elc_1']);
    expect(queue.list('sess_2').map((item) => item.elicitationId)).toEqual(['elc_2']);
    expect(queue.list()).toHaveLength(2);
    queue.dispose();
  });

  it('fails closed when a reused id crosses session boundaries', async () => {
    const queue = new ElicitationQueue(transportWith());
    await queue.receiveRequested(requested());

    const collision = await queue.receiveRequested(requested({ session_id: 'sess_other' }));
    expect(collision).toMatchObject({ type: 'malformed', error: { elicitationId: 'elc_1' } });
    expect(queue.get('elc_1')?.sessionId).toBe('sess_1');
    expect(() =>
      queue.receiveResolved({ elicitation_id: 'elc_1', session_id: 'sess_other', status: 'cancelled' })
    ).toThrow('different session');
    expect(queue.get('elc_1')).toBeDefined();
  });

  it('declines unknown kinds and unsupported schemas rather than queuing them', async () => {
    const transport = transportWith(async (params) => ({ elicitation_id: params.elicitation_id, status: 'declined' }));
    const queue = new ElicitationQueue(transport);

    const unknown = await queue.receiveRequested(requested({ kind: 'calendar' }));
    const complex = await queue.receiveRequested(
      requested({
        elicitation_id: 'elc_2',
        kind: 'form',
        input_schema: { type: 'object', properties: { nested: { type: 'object' } } },
      })
    );

    expect(unknown).toMatchObject({ type: 'unsupported', elicitationId: 'elc_1', responseSent: true });
    expect(complex).toMatchObject({ type: 'unsupported', elicitationId: 'elc_2', responseSent: true });
    expect(transport.calls).toEqual([
      expect.objectContaining({ elicitation_id: 'elc_1', action: 'decline' }),
      expect.objectContaining({ elicitation_id: 'elc_2', action: 'decline' }),
    ]);
    expect(queue.list()).toEqual([]);
  });

  it('converges concurrent local answers on the first request', async () => {
    let finish!: (value: Record<string, unknown>) => void;
    const transport = transportWith(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const queue = new ElicitationQueue(transport);
    await queue.receiveRequested(requested());

    const first = queue.respond('elc_1', { action: 'accept', value: { text: 'first' } });
    const second = queue.respond('elc_1', { action: 'decline', reason: 'second' });
    expect(second).toBe(first);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({ action: 'accept', value: { text: 'first' } });

    finish({ elicitation_id: 'elc_1', status: 'accepted' });
    await expect(first).resolves.toEqual({ elicitationId: 'elc_1', status: 'accepted', won: true });
    expect(queue.get('elc_1')).toBeUndefined();
  });

  it('converges a server already-resolved error and removes the losing prompt', async () => {
    const transport = transportWith(async () => {
      const error = new Error('already resolved') as Error & { code: number; data: Record<string, unknown> };
      error.code = -32051;
      error.data = { status: 'declined' };
      throw error;
    });
    const queue = new ElicitationQueue(transport);
    await queue.receiveRequested(requested());

    await expect(queue.respond('elc_1', { action: 'accept', value: { text: 'late' } })).resolves.toEqual({
      elicitationId: 'elc_1',
      status: 'declined',
      won: false,
    });
    expect(queue.get('elc_1')).toBeUndefined();
  });

  it('keeps invalid submissions pending and off the wire', async () => {
    const transport = transportWith();
    const queue = new ElicitationQueue(transport);
    await queue.receiveRequested(requested());

    await expect(queue.respond('elc_1', { action: 'accept', value: { text: '' } })).rejects.toBeInstanceOf(
      ElicitationValidationError
    );
    expect(transport.calls).toHaveLength(0);
    expect(queue.get('elc_1')).toBeDefined();
  });

  it('expires locally without sending a response and removes the prompt', async () => {
    const transport = transportWith();
    const events: ElicitationQueueEvent[] = [];
    const queue = new ElicitationQueue(transport, { now: () => 1_000 });
    queue.onChange((event) => events.push(event));
    await queue.receiveRequested(requested({ timeout_ms: 250 }));

    await vi.advanceTimersByTimeAsync(249);
    expect(queue.get('elc_1')).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.get('elc_1')).toBeUndefined();
    expect(transport.calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'removed', resolution: { status: 'expired' } });
  });

  it('never exposes non-persisted resolved values and allows explicitly persisted ones', async () => {
    const queue = new ElicitationQueue(transportWith());
    const events: ElicitationQueueEvent[] = [];
    queue.onChange((event) => events.push(event));
    await queue.receiveRequested(requested());
    const sensitive = queue.receiveResolved({
      elicitation_id: 'elc_1',
      status: 'accepted',
      value: { text: 'secret' },
    });
    expect(sensitive).not.toHaveProperty('value');
    expect(events.at(-1)).not.toHaveProperty('resolution.value');

    await queue.receiveRequested(requested({ elicitation_id: 'elc_2', persist_response: true }));
    const persisted = queue.receiveResolved({
      elicitation_id: 'elc_2',
      status: 'accepted',
      value: { text: 'public' },
    });
    expect(persisted.value).toEqual({ text: 'public' });
    expect(events.at(-1)).toHaveProperty('resolution.value', { text: 'public' });
  });

  it('removes prompts on every terminal server status', async () => {
    for (const status of ['accepted', 'declined', 'cancelled', 'expired', 'server_restart'] as const) {
      const queue = new ElicitationQueue(transportWith());
      await queue.receiveRequested(requested());
      queue.receiveResolved({ elicitation_id: 'elc_1', status });
      expect(queue.get('elc_1'), status).toBeUndefined();
    }
  });
});
