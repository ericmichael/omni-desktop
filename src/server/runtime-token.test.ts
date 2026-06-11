import { describe, expect, it } from 'vitest';

import { resolveRuntimeTokenSecret, signRuntimeToken, verifyRuntimeToken } from '@/server/runtime-token';

const SECRET = 'test-secret-at-least-16-chars-long';

describe('runtime token', () => {
  it('round-trips claims', () => {
    const token = signRuntimeToken(SECRET, { tenantId: 'tenant-a', sessionId: 'sess-1' });
    expect(verifyRuntimeToken(SECRET, token)).toEqual({ tenantId: 'tenant-a', sessionId: 'sess-1' });
  });

  it('rejects a token signed with a different secret (unforgeable across secrets)', () => {
    const token = signRuntimeToken(SECRET, { tenantId: 'tenant-a', sessionId: 'sess-1' });
    expect(verifyRuntimeToken('another-secret-16chars!!', token)).toBeNull();
  });

  it('rejects a tampered tenant claim', () => {
    const token = signRuntimeToken(SECRET, { tenantId: 'tenant-a', sessionId: 'sess-1' });
    const [, sig] = token.split('.');
    // Re-encode the payload to claim a different tenant but keep the old MAC.
    const forgedPayload = Buffer.from(
      JSON.stringify({ tid: 'tenant-victim', sid: 'sess-1', iat: 1, exp: 9_999_999_999 })
    ).toString('base64url');
    expect(verifyRuntimeToken(SECRET, `${forgedPayload}.${sig}`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const now = Date.now();
    const token = signRuntimeToken(SECRET, { tenantId: 'tenant-a', sessionId: 'sess-1' }, 60, now);
    // 61s later → past the 60s TTL.
    expect(verifyRuntimeToken(SECRET, token, now + 61_000)).toBeNull();
    expect(verifyRuntimeToken(SECRET, token, now + 59_000)).not.toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyRuntimeToken(SECRET, '')).toBeNull();
    expect(verifyRuntimeToken(SECRET, 'no-dot')).toBeNull();
    expect(verifyRuntimeToken(SECRET, '.sig')).toBeNull();
    expect(verifyRuntimeToken(SECRET, 'garbage.payload')).toBeNull();
  });

  it('prefers an explicit secret of sufficient length', () => {
    expect(resolveRuntimeTokenSecret({ OMNI_RUNTIME_TOKEN_SECRET: 'x'.repeat(32) } as NodeJS.ProcessEnv)).toBe(
      'x'.repeat(32)
    );
  });

  it('falls back to a random secret when none is configured', () => {
    const a = resolveRuntimeTokenSecret({} as NodeJS.ProcessEnv);
    const b = resolveRuntimeTokenSecret({} as NodeJS.ProcessEnv);
    expect(a).not.toBe(b); // random per call
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
});
