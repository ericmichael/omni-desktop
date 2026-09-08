import { guiInitializeResult } from 'tests/unit/gui-initialize';
import { describe, expect, it } from 'vitest';

import { guiInitializationError, validateGuiInitialization } from './omniagents-protocol';
import { OmniagentsRpcError } from './omniagents-rpc';

describe('GUI v2 handshake boundary', () => {
  it.each(['1.0.0', '3.0.0', '2.0.0-dev', '02.0.0', '2.0.0\n', ''])('rejects %s', (version) => {
    expect(() => validateGuiInitialization(guiInitializeResult({ protocol_version: version }))).toThrow(
      'Incompatible chat protocol'
    );
  });
  it.each(['2.0.0', '2.0.1', '2.1.0'])('accepts compatible %s', (version) => {
    expect(validateGuiInitialization(guiInitializeResult({ protocol_version: version })).protocol_version).toBe(
      version
    );
  });
  it('rejects partial success', () => {
    expect(() => validateGuiInitialization({ protocol_version: '2.0.0' })).toThrow('Invalid chat initialization');
  });
  it('formats a server-side mismatch without downgrading it to a retryable error', () => {
    const error = guiInitializationError(
      new OmniagentsRpcError({
        code: -32012,
        message: 'Unsupported protocol version',
        data: { server_version: '1.0.0' },
      })
    );
    expect(error).toMatchObject({ code: -32012, data: { server_version: '1.0.0' } });
    expect((error as Error).message).toContain('Update Desktop and the agent server together');
  });
});
