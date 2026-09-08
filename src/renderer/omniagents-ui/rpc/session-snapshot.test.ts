import { expect, it } from 'vitest';

import { historyPage } from '@/renderer/omniagents-ui/session/session-test-support';

import { decodeSessionSnapshot } from './session-snapshot';

function result() {
  return {
    session_id: 'owner',
    run_active: false,
    snapshot: {
      items: historyPage('owner', 'message').items,
      queue: [],
      pending_requests: [],
      stream_id: 'epoch',
      last_seq: 3,
    },
  };
}

it('accepts a valid snapshot while preserving additive fields', () => {
  expect(decodeSessionSnapshot({ ...result(), future: true }, 'owner').future).toBe(true);
});
it.each([
  'foreign-session',
  'foreign-item',
  'duplicate-item',
  'invalid-cursor',
  'missing-items',
  'foreign-request',
  'unsupported',
  'missing-run',
  'executable-state-event',
  'foreign-state-event',
])('rejects %s before hydration', (failure) => {
  const response: any = result();
  if (failure === 'foreign-session') {
    response.session_id = 'other';
  }
  if (failure === 'foreign-item') {
    response.snapshot.items[0].thread_id = 'other';
  }
  if (failure === 'duplicate-item') {
    response.snapshot.items.push(response.snapshot.items[0]);
  }
  if (failure === 'invalid-cursor') {
    response.snapshot.last_seq = NaN;
  }
  if (failure === 'missing-items') {
    delete response.snapshot.items;
  }
  if (failure === 'foreign-request') {
    response.snapshot.pending_requests = [{ session_id: 'other', request_id: 'id', function: 'tool.call' }];
  }
  if (failure === 'unsupported') {
    delete response.snapshot;
  }
  if (failure === 'missing-run') {
    response.run_active = true;
  }
  if (failure === 'executable-state-event') {
    response.snapshot.state_events = [
      { method: 'client_request', params: { session_id: 'owner', function: 'tool.call' } },
    ];
  }
  if (failure === 'foreign-state-event') {
    response.snapshot.state_events = [{ method: 'run_status', params: { session_id: 'other', status: 'running' } }];
  }
  expect(() => decodeSessionSnapshot(response, 'owner')).toThrow();
});
