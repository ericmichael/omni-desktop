import {
  GUI_PROTOCOL_VERSION,
  type InitializeResult,
  isGuiInitializeResult,
  supportsGuiProtocolVersion,
} from '@/generated/omniagents-gui-v2/gui-v2';

import { OmniagentsRpcError } from './omniagents-rpc';

/** Shared by renderer and main-process clients; no ready state before validation. */
export function validateGuiInitialization(value: unknown): InitializeResult {
  const version =
    value && typeof value === 'object' && 'protocol_version' in value ? value.protocol_version : undefined;
  if (!supportsGuiProtocolVersion(version)) {
    throw new OmniagentsRpcError({
      code: -32012,
      message: `Incompatible chat protocol: Desktop requires v${GUI_PROTOCOL_VERSION}; server reports ${typeof version === 'string' ? version : 'an invalid version'}. Update Desktop and the agent server together.`,
      data: { kind: 'protocol_version_mismatch', client_version: GUI_PROTOCOL_VERSION, server_version: version },
    });
  }
  if (!isGuiInitializeResult(value)) {
    throw new OmniagentsRpcError({
      code: -32602,
      message: 'Invalid chat initialization response. Update the agent server.',
      data: { kind: 'invalid_initialize_result' },
    });
  }
  return value;
}

export function guiInitializationError(error: unknown): unknown {
  if (error instanceof OmniagentsRpcError && error.code === -32012) {
    const data = error.data as { server_version?: unknown } | undefined;
    // Use the same actionable message for an explicit rejection and a false success.
    try {
      validateGuiInitialization({ protocol_version: data?.server_version });
    } catch (formatted) {
      if (formatted instanceof OmniagentsRpcError && formatted.code === -32012) {
        return formatted;
      }
    }
  }
  return error;
}
