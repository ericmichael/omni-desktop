import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelCatalogRpcTransport } from '@/renderer/omniagents-ui/rpc/model-catalog';

import { ModelSessionControls } from './ModelSessionControls';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

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
  container.remove();
  document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((element) => element.remove());
});

describe('ModelSessionControls', () => {
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
