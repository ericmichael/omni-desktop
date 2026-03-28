import { describe, expect, it } from 'vitest';

import type { SandboxProcessStatus } from '@/shared/types';

import { getSandboxReadinessTargets } from './sandbox-manager';

describe('getSandboxReadinessTargets', () => {
  it('requires the local UI and sandbox websocket for readiness', () => {
    const data: Extract<SandboxProcessStatus, { type: 'running' }>['data'] = {
      sandboxUrl: 'http://localhost:42903',
      wsUrl: 'ws://localhost:42903/ws',
      uiUrl: 'http://localhost:41141',
      codeServerUrl: 'http://localhost:39907',
      noVncUrl: 'http://localhost:48405/vnc.html?autoconnect=true&resize=scale',
      containerId: 'container-id',
      containerName: undefined,
      ports: {
        sandbox: 42903,
        ui: 41141,
        codeServer: 39907,
        vnc: 48405,
      },
    };

    expect(getSandboxReadinessTargets(data)).toEqual([
      { label: 'ui', url: 'http://localhost:41141', protocol: 'http' },
      { label: 'ws', url: 'ws://localhost:42903/ws', protocol: 'ws' },
    ]);
  });

  it('does not change when optional services are absent', () => {
    const data: Extract<SandboxProcessStatus, { type: 'running' }>['data'] = {
      sandboxUrl: 'http://localhost:35587',
      wsUrl: 'ws://localhost:35587/ws',
      uiUrl: 'http://localhost:56373',
      codeServerUrl: undefined,
      noVncUrl: undefined,
      containerId: 'container-id',
      containerName: undefined,
      ports: {
        sandbox: 35587,
        ui: 56373,
        codeServer: undefined,
        vnc: undefined,
      },
    };

    expect(getSandboxReadinessTargets(data)).toEqual([
      { label: 'ui', url: 'http://localhost:56373', protocol: 'http' },
      { label: 'ws', url: 'ws://localhost:35587/ws', protocol: 'ws' },
    ]);
  });
});
