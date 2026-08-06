// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  cliExists: true,
  execResult: { kind: 'success', stdout: '' } as
    | { kind: 'success'; stdout: string }
    | { kind: 'error'; error: NodeJS.ErrnoException },
}));

vi.mock('node:child_process', () => {
  const execFile = vi.fn(
    (
      _file: string,
      _args: string[],
      _options: { timeout: number },
      callback: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      if (hoisted.execResult.kind === 'error') {
        callback(hoisted.execResult.error);
      } else {
        callback(null, hoisted.execResult.stdout, '');
      }
    }
  );
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: async () => {
      if (hoisted.execResult.kind === 'error') {
        throw hoisted.execResult.error;
      }
      return { stdout: hoisted.execResult.stdout, stderr: '' };
    },
  });
  return { execFile };
});

vi.mock('@/main/util', () => ({
  getOmniCliPath: vi.fn(() => '/runtime/bin/omni'),
  pathExists: vi.fn(async () => hoisted.cliExists),
}));

import { setCachedProductRuntimeInfo } from '@/lib/product';
import {
  assertServeProtocolSupported,
  PRODUCT_DESCRIBE_TIMEOUT_MS,
  refreshProductRuntimeInfo,
} from '@/main/product-runtime';

const describePayload = (serveProtocol: number): string =>
  JSON.stringify({
    name: 'omni-code',
    prog: 'omni',
    label: 'Omni Code',
    slug: 'omni_code',
    version: '0.6.20',
    config_dir: '/tmp/omni-code',
    env_prefix: 'OMNI_CODE',
    update: null,
    serve_protocol: serveProtocol,
  });

beforeEach(() => {
  hoisted.cliExists = true;
  hoisted.execResult = { kind: 'success', stdout: describePayload(2) };
  setCachedProductRuntimeInfo(null);
});

afterEach(async () => {
  // Missing-runtime refresh also clears private failure state.
  hoisted.cliExists = false;
  await refreshProductRuntimeInfo();
  vi.clearAllMocks();
});

describe('Serve Protocol v2 runtime preflight', () => {
  it('accepts an installed protocol v2 runtime', async () => {
    await expect(assertServeProtocolSupported()).resolves.toBeUndefined();
  });

  it('rejects an installed protocol v1 runtime with update guidance', async () => {
    hoisted.execResult = { kind: 'success', stdout: describePayload(1) };

    await expect(assertServeProtocolSupported()).rejects.toThrow(
      /speaks serve protocol v1, but this launcher requires v2.*Update Omni Code/s
    );
  });

  it('allows the runtime to be absent so installation can proceed', async () => {
    hoisted.cliExists = false;

    await expect(assertServeProtocolSupported()).resolves.toBeUndefined();
  });

  it('fails closed when describe returns malformed JSON', async () => {
    hoisted.execResult = { kind: 'success', stdout: '{not-json' };

    await expect(assertServeProtocolSupported()).rejects.toThrow(
      /Installed omni-code cannot be started because `\/runtime\/bin\/omni describe --json` failed:.*requires a runtime that reports Serve Protocol v2.*Reinstall or update omni-code/s
    );
  });

  it('fails closed when describe returns a malformed payload', async () => {
    hoisted.execResult = { kind: 'success', stdout: JSON.stringify({ serve_protocol: 2 }) };

    await expect(assertServeProtocolSupported()).rejects.toThrow(/payload is missing "name"/);
  });

  it('fails closed when describe cannot execute, even after a successful cached result', async () => {
    await expect(refreshProductRuntimeInfo()).resolves.toMatchObject({ serveProtocol: 2 });
    hoisted.execResult = { kind: 'error', error: Object.assign(new Error('EACCES'), { code: 'EACCES' }) };

    await expect(assertServeProtocolSupported()).rejects.toThrow(/describe --json` failed: EACCES/);
  });

  it('reports describe timeouts distinctly', async () => {
    hoisted.execResult = {
      kind: 'error',
      error: Object.assign(new Error('Command timed out'), { code: 'ETIMEDOUT' }),
    };

    await expect(assertServeProtocolSupported()).rejects.toThrow(
      new RegExp(`describe --json.*timed out after ${PRODUCT_DESCRIBE_TIMEOUT_MS / 1_000} seconds`)
    );
  });
});
