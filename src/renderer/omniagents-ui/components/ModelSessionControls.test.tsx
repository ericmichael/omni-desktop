import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelCatalogRpcTransport } from '@/renderer/omniagents-ui/rpc/model-catalog';
import { SessionRegistry } from '@/renderer/omniagents-ui/session/session-registry';
import { deferred, fakeSessionClient } from '@/renderer/omniagents-ui/session/session-test-support';

import { ModelSessionControls } from './ModelSessionControls';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
let registry: SessionRegistry | undefined;

const model = (id: string, label: string) => ({
  id,
  model: id,
  label,
  description: null,
  provider: { name: 'Omni', type: 'openai-compatible' },
  modalities: ['text'],
  realtime: false,
  limits: { max_input_tokens: 1000, max_output_tokens: 100 },
  reasoning: { default: 'medium', options: ['low', 'medium', 'high'] },
  tiers: { service: null, speed: null },
  personality: { supported: false, options: [], default: null },
  availability: { available: true, reasons: [] },
  entitlement: { entitled: true, credential: 'configured' },
  deprecation: { deprecated: false, message: null, replace_with: null },
  hidden: false,
  is_default: id === 'model-1',
  is_voice_default: false,
  is_user_defined: false,
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  registry?.dispose();
  registry = undefined;
  container.remove();
  document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((element) => element.remove());
});

describe('ModelSessionControls', () => {
  it('shows the catalog default when a remote update clears the explicit model override', async () => {
    registry = new SessionRegistry(fakeSessionClient().client);
    const session = registry.get('A');
    session.panels.set('models', [model('model-1', 'Model One'), model('model-2', 'Model Two')]);
    session.panels.set('activeModel', 'model-2');
    session.panels.set('modelLoading', false);
    const transport = { request: vi.fn() } as unknown as ModelCatalogRpcTransport;
    await act(async () =>
      root.render(<ModelSessionControls sessionId="A" session={session} transport={transport} connected={false} />)
    );
    await act(async () => session.panels.set('activeModel', null));
    expect(container.textContent).toContain('Model One');
    expect(container.textContent).not.toContain('Loading models');
  });
  it('does not surface an old catalog failure after a newer reconnect read succeeds', async () => {
    registry = new SessionRegistry(fakeSessionClient().client);
    const session = registry.get('A');
    const oldRead = deferred<any>();
    const newRead = deferred<any>();
    const request = vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const transport = { request } as unknown as ModelCatalogRpcTransport;
    await act(async () => root.render(<ModelSessionControls sessionId="A" session={session} transport={transport} />));
    await act(async () =>
      root.render(<ModelSessionControls sessionId="A" session={session} transport={transport} connected={false} />)
    );
    await act(async () => root.render(<ModelSessionControls sessionId="A" session={session} transport={transport} />));
    await act(async () =>
      newRead.resolve({
        models: [model('model-2', 'Model Two')],
        default_model: 'model-2',
        voice_default_model: null,
        errors: [],
        reasons: [],
        session: { session_id: 'A', active_model: 'model-2', reasoning_effort: 'high' },
      })
    );
    await act(async () => oldRead.reject(new Error('stale connection failed')));
    expect(session.panels.state.get().modelError).toBeNull();
    expect(session.panels.state.get().modelLoading).toBe(false);
    expect(container.textContent).toContain('Model Two');
  });
  it('keeps session-owned selections across view unmounts', async () => {
    registry = new SessionRegistry(fakeSessionClient().client);
    const session = registry.get('A');
    const response = deferred<any>();
    const transport = { request: vi.fn(() => response.promise) } as unknown as ModelCatalogRpcTransport;
    await act(async () => root.render(<ModelSessionControls sessionId="A" session={session} transport={transport} />));
    await act(async () =>
      response.resolve({
        models: [model('model-1', 'Model One'), model('model-2', 'Model Two')],
        default_model: 'model-1',
        voice_default_model: null,
        errors: [],
        reasons: [],
        session: { session_id: 'A', active_model: 'model-2', reasoning_effort: 'low' },
      })
    );
    expect(container.textContent).toContain('Model Two');
    await act(async () => root.render(null));
    await act(async () =>
      root.render(<ModelSessionControls sessionId="A" session={session} transport={transport} connected={false} />)
    );
    expect(container.textContent).toContain('Model Two');
  });

  it('renders the same settings in two views of one session', async () => {
    registry = new SessionRegistry(fakeSessionClient().client);
    const session = registry.get('A');
    session.panels.set('models', [model('model-1', 'Model One'), model('model-2', 'Model Two')]);
    session.panels.set('activeModel', 'model-1');
    session.panels.set('modelLoading', false);
    const transport = { request: vi.fn() } as unknown as ModelCatalogRpcTransport;
    await act(async () =>
      root.render(
        <>
          <ModelSessionControls sessionId="A" session={session} transport={transport} connected={false} />
          <ModelSessionControls sessionId="A" session={session} transport={transport} connected={false} />
        </>
      )
    );
    await act(async () => session.panels.set('activeModel', 'model-2'));
    expect(
      [...container.querySelectorAll('[data-testid="model-session-controls"]')].map((element) => element.textContent)
    ).toEqual([expect.stringContaining('Model Two'), expect.stringContaining('Model Two')]);
  });
  it('keeps the selected model visible while disconnected and refreshes on reconnect', async () => {
    const request = vi.fn(async () => ({
      models: [model('model-1', 'Model One')],
      default_model: 'model-1',
      voice_default_model: null,
      errors: [],
      reasons: [],
      session: { session_id: 'reconnect', active_model: 'model-1', reasoning_effort: 'medium' },
    }));
    const transport = { request } as unknown as ModelCatalogRpcTransport;
    await act(async () => {
      root.render(<ModelSessionControls sessionId="reconnect" transport={transport} />);
    });
    const button = container.querySelector('button')!;
    await act(async () => {
      root.render(<ModelSessionControls sessionId="reconnect" transport={transport} connected={false} />);
    });
    expect(container.textContent).toContain('Model One');
    expect(container.querySelector('button')).toBe(button);
    expect(button.disabled).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(<ModelSessionControls sessionId="reconnect" transport={transport} connected />);
    });
    expect(button.disabled).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('loads the session-scoped catalog and exposes model and reasoning controls', async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== 'list_models') {
        throw new Error(`unexpected ${method}`);
      }
      return {
        models: [model('model-1', 'Model One'), model('model-2', 'Model Two')],
        default_model: 'model-1',
        voice_default_model: null,
        errors: [],
        reasons: [],
        session: { session_id: 'session-1', active_model: 'model-2', reasoning_effort: 'high' },
      };
    });
    const transport = { request } as unknown as ModelCatalogRpcTransport;

    await act(async () => {
      root.render(<ModelSessionControls sessionId="session-1" transport={transport} />);
      await Promise.resolve();
    });

    expect(request).toHaveBeenCalledWith('list_models', { session_id: 'session-1' });
    expect(container.textContent).toContain('Model Two');
    expect(container.textContent).toContain('high');
    expect(container.querySelector('[data-testid="model-session-controls"]')).not.toBeNull();
  });

  it('locks both controls while a run is active', async () => {
    const transport = {
      request: vi.fn(async () => ({
        models: [model('model-1', 'Model One')],
        default_model: 'model-1',
        voice_default_model: null,
        errors: [],
        reasons: [],
        session: { session_id: 'session-1', active_model: 'model-1', reasoning_effort: 'medium' },
      })),
    } as unknown as ModelCatalogRpcTransport;

    await act(async () => {
      root.render(<ModelSessionControls sessionId="session-1" transport={transport} disabled />);
      await Promise.resolve();
    });

    expect([...container.querySelectorAll('button')]).toHaveLength(2);
    expect([...container.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
  });
});

describe('approvals reviewer control', () => {
  const transportWith = (reviewer: string | null) =>
    ({
      request: vi.fn(async () => ({
        models: [model('model-1', 'Model One')],
        default_model: 'model-1',
        voice_default_model: null,
        errors: [],
        reasons: [],
        session: {
          session_id: 'session-1',
          active_model: 'model-1',
          reasoning_effort: 'medium',
          approvals_reviewer: reviewer,
        },
      })),
    }) as unknown as ModelCatalogRpcTransport;

  it('renders only when the feature negotiated, restoring the session state', async () => {
    await act(async () => {
      root.render(
        <ModelSessionControls
          sessionId="session-1"
          transport={transportWith('auto')}
          approvalsSupported
          onSetApprovalsReviewer={vi.fn(async () => ({}))}
        />
      );
      await Promise.resolve();
    });
    const control = container.querySelector('[data-testid="approvals-reviewer-control"]');
    expect(control).not.toBeNull();
    expect(control!.textContent).toContain('Approve for me');
  });

  it('stays hidden without negotiation', async () => {
    await act(async () => {
      root.render(<ModelSessionControls sessionId="session-1" transport={transportWith(null)} />);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="approvals-reviewer-control"]')).toBeNull();
  });

  it('defaults to Ask me when the session has no override', async () => {
    await act(async () => {
      root.render(
        <ModelSessionControls
          sessionId="session-1"
          transport={transportWith(null)}
          approvalsSupported
          onSetApprovalsReviewer={vi.fn(async () => ({}))}
        />
      );
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="approvals-reviewer-control"]')!.textContent).toContain('Ask me');
  });
});

describe('sandbox network control', () => {
  const transport = () =>
    ({
      request: vi.fn(async () => ({
        models: [model('model-1', 'Model One')],
        default_model: 'model-1',
        voice_default_model: null,
        errors: [],
        reasons: [],
        session: { session_id: 'session-1', active_model: 'model-1', reasoning_effort: 'medium' },
      })),
    }) as unknown as ModelCatalogRpcTransport;

  it('renders the pill from the probe and reflects the offline state', async () => {
    const getNetwork = vi.fn(async () => ({ ok: true, supported: true, enabled: false }));
    await act(async () => {
      root.render(
        <ModelSessionControls
          sessionId="session-1"
          transport={transport()}
          onGetSandboxNetwork={getNetwork}
          onSetSandboxNetwork={vi.fn(async () => ({ ok: true }))}
        />
      );
      await Promise.resolve();
    });
    const control = container.querySelector('[data-testid="sandbox-network-control"]');
    expect(getNetwork).toHaveBeenCalledOnce();
    expect(control).not.toBeNull();
    expect(control!.textContent).toContain('Offline');
  });

  it('hides the pill when the probe reports unsupported or rejects', async () => {
    await act(async () => {
      root.render(
        <ModelSessionControls
          sessionId="session-1"
          transport={transport()}
          onGetSandboxNetwork={vi.fn(async () => ({ ok: true, supported: false, enabled: true }))}
          onSetSandboxNetwork={vi.fn(async () => ({ ok: true }))}
        />
      );
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="sandbox-network-control"]')).toBeNull();

    await act(async () => {
      root.render(
        <ModelSessionControls
          sessionId="session-1"
          transport={transport()}
          onGetSandboxNetwork={vi.fn(async () => {
            throw new Error('unknown function');
          })}
          onSetSandboxNetwork={vi.fn(async () => ({ ok: true }))}
        />
      );
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="sandbox-network-control"]')).toBeNull();
  });

  it('stays usable while a run is active — the live toggle is the point', async () => {
    await act(async () => {
      root.render(
        <ModelSessionControls
          sessionId="session-1"
          transport={transport()}
          disabled
          onGetSandboxNetwork={vi.fn(async () => ({ ok: true, supported: true, enabled: true }))}
          onSetSandboxNetwork={vi.fn(async () => ({ ok: true }))}
        />
      );
      await Promise.resolve();
    });
    const control = container.querySelector<HTMLButtonElement>('[data-testid="sandbox-network-control"]');
    expect(control).not.toBeNull();
    expect(control!.textContent).toContain('Internet on');
    expect(control!.disabled).toBe(false);
  });
});
