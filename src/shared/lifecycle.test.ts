import { describe, expect, it } from 'vitest';

import {
  classifyCloseCode,
  classifyRpcErrorCode,
  ConnectionClosedError,
  DEFAULT_LIFECYCLE_POLICY,
  type LifecyclePolicy,
  ReconnectController,
  reconnectDelayMs,
} from '@/shared/lifecycle';

describe('DEFAULT_LIFECYCLE_POLICY', () => {
  it('matches the omniagents standard policy defaults', () => {
    expect(DEFAULT_LIFECYCLE_POLICY).toEqual({
      connectTimeoutMs: 10000,
      rpcTimeoutMs: 60000,
      pingIntervalMs: 20000,
      pingTimeoutMs: 10000,
      reconnectInitialDelayMs: 500,
      reconnectMultiplier: 2.0,
      reconnectMaxDelayMs: 30000,
      reconnectJitter: 0.1,
      reconnectMaxAttempts: 10,
    });
  });
});

describe('classifyCloseCode', () => {
  it('classifies the shared permanent close codes as permanent', () => {
    for (const code of [1002, 1003, 1008, 4400, 4401, 4403, 4404]) {
      expect(classifyCloseCode(code)).toBe('permanent');
    }
  });

  it('treats the whole 44xx application range as permanent', () => {
    expect(classifyCloseCode(4402)).toBe('permanent');
    expect(classifyCloseCode(4450)).toBe('permanent');
    expect(classifyCloseCode(4499)).toBe('permanent');
  });

  it('classifies everything else as retryable', () => {
    for (const code of [1000, 1001, 1006, 1011, 1012, 1013, 4500, 3000]) {
      expect(classifyCloseCode(code)).toBe('retryable');
    }
  });

  it('classifies a missing close code as retryable', () => {
    expect(classifyCloseCode(null)).toBe('retryable');
    expect(classifyCloseCode(undefined)).toBe('retryable');
  });
});

describe('classifyRpcErrorCode', () => {
  it('classifies malformed-request and handshake codes as permanent', () => {
    for (const code of [-32700, -32600, -32601, -32602, -32010, -32011, -32012, -32013]) {
      expect(classifyRpcErrorCode(code)).toBe('permanent');
    }
  });

  it('classifies TransportOverloaded as retryable and the rest as indeterminate', () => {
    expect(classifyRpcErrorCode(-32020)).toBe('retryable');
    expect(classifyRpcErrorCode(-32603)).toBe('indeterminate');
    expect(classifyRpcErrorCode(1234)).toBe('indeterminate');
  });
});

describe('reconnectDelayMs', () => {
  const midJitter = () => 0.5; // rng of 0.5 cancels the symmetric jitter

  it('follows the 0.5s ×2 → 30s cap schedule', () => {
    expect(reconnectDelayMs(DEFAULT_LIFECYCLE_POLICY, 1, midJitter)).toBe(500);
    expect(reconnectDelayMs(DEFAULT_LIFECYCLE_POLICY, 2, midJitter)).toBe(1000);
    expect(reconnectDelayMs(DEFAULT_LIFECYCLE_POLICY, 3, midJitter)).toBe(2000);
    expect(reconnectDelayMs(DEFAULT_LIFECYCLE_POLICY, 6, midJitter)).toBe(16000);
    expect(reconnectDelayMs(DEFAULT_LIFECYCLE_POLICY, 7, midJitter)).toBe(30000);
    expect(reconnectDelayMs(DEFAULT_LIFECYCLE_POLICY, 20, midJitter)).toBe(30000);
  });

  it('applies ±10% symmetric jitter', () => {
    expect(reconnectDelayMs(DEFAULT_LIFECYCLE_POLICY, 2, () => 0)).toBe(900);
    expect(reconnectDelayMs(DEFAULT_LIFECYCLE_POLICY, 2, () => 1)).toBe(1100);
  });

  it('clamps attempt to 1', () => {
    expect(reconnectDelayMs(DEFAULT_LIFECYCLE_POLICY, 0, midJitter)).toBe(500);
  });
});

describe('ReconnectController', () => {
  it('retries with the scheduled delay until the budget is exhausted', () => {
    const ctrl = new ReconnectController(DEFAULT_LIFECYCLE_POLICY, () => 0.5);
    for (let attempt = 1; attempt <= 9; attempt++) {
      const decision = ctrl.recordFailure();
      expect(decision.retry).toBe(true);
      expect(decision.attempt).toBe(attempt);
      expect(decision.permanent).toBe(false);
    }
    const last = ctrl.recordFailure();
    expect(last).toEqual({ retry: false, delayMs: 0, attempt: 10, permanent: true });
  });

  it('stops immediately on a permanent failure', () => {
    const ctrl = new ReconnectController();
    const decision = ctrl.recordFailure({ permanent: true });
    expect(decision).toEqual({ retry: false, delayMs: 0, attempt: 1, permanent: true });
  });

  it('resets the consecutive-failure budget on success', () => {
    const ctrl = new ReconnectController(DEFAULT_LIFECYCLE_POLICY, () => 0.5);
    for (let i = 0; i < 9; i++) {
      expect(ctrl.recordFailure().retry).toBe(true);
    }
    ctrl.recordSuccess();
    expect(ctrl.attempts).toBe(0);
    const decision = ctrl.recordFailure();
    expect(decision.retry).toBe(true);
    expect(decision.attempt).toBe(1);
  });

  it('never exhausts with an infinite budget (local-server policy)', () => {
    const local: LifecyclePolicy = { ...DEFAULT_LIFECYCLE_POLICY, reconnectMaxAttempts: Number.POSITIVE_INFINITY };
    const ctrl = new ReconnectController(local, () => 0.5);
    for (let i = 0; i < 100; i++) {
      expect(ctrl.recordFailure().retry).toBe(true);
    }
    // The delay stays capped at the ceiling.
    const decision = ctrl.recordFailure();
    expect(decision.delayMs).toBe(30000);
  });
});

describe('ConnectionClosedError', () => {
  it('carries the structured close info', () => {
    const err = new ConnectionClosedError('gone', { permanent: true, closeCode: 4401, reason: 'token rejected' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ConnectionClosedError');
    expect(err.permanent).toBe(true);
    expect(err.closeCode).toBe(4401);
    expect(err.reason).toBe('token rejected');
  });

  it('defaults to a retryable close', () => {
    const err = new ConnectionClosedError();
    expect(err.permanent).toBe(false);
    expect(err.closeCode).toBeUndefined();
  });
});
