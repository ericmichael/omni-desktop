import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagementSnapshot } from '@/renderer/omniagents-ui/rpc/management-repository';

const mocks = vi.hoisted(() => ({
  snapshot: null as unknown as ManagementSnapshot,
  refresh: vi.fn(),
  validateConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock('@/renderer/omniagents-ui/product-management-context', () => ({
  useProductManagement: () => ({
    status: 'ready',
    error: null,
    mutationCapabilities: { validateConfig: true, writeConfig: true },
  }),
  useProductManagementRefresh: () => mocks.refresh,
  useProductManagementSnapshot: () => mocks.snapshot,
}));

vi.mock('@/renderer/services/management-admin', () => ({
  managementAdminApi: {
    validateConfig: mocks.validateConfig,
    writeConfig: mocks.writeConfig,
  },
}));

import { SettingsModalRuntimePolicyTab } from './SettingsModalRuntimePolicyTab';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const writeTarget = '/config/project.d/90-gui.yml';
const baseField = {
  description: 'A runtime policy setting.',
  secret: false,
  reload: 'restart',
  read_only: false,
  read_only_reason: null,
  is_set: true,
  effective_layer: 'project',
  layers: [{ layer: 'project', source: '/app/project.yml', is_set: true }],
};

function snapshot(): ManagementSnapshot {
  return {
    revision: 1,
    connection: 'connected',
    status: 'ready',
    experimental: {
      mcpReadResource: true,
      mcpCallTool: true,
      mcpGetPrompt: true,
      configRead: true,
      configValidate: false,
      configWrite: false,
    },
    models: { status: 'ready', data: null, error: null, updatedAt: 1 },
    providers: { status: 'ready', data: null, error: null, updatedAt: 1 },
    accounts: { status: 'ready', data: null, error: null, updatedAt: 1 },
    mcp: { status: 'ready', data: null, error: null, updatedAt: 1 },
    config: {
      status: 'ready',
      error: null,
      updatedAt: 1,
      data: {
        layers: [
          { name: 'defaults', writable: false, sources: [] },
          { name: 'user', writable: true, sources: [writeTarget], write_target: writeTarget },
        ],
        fields: [
          {
            ...baseField,
            key: 'product.name',
            type: 'string',
            label: 'Product name',
            value: 'Omni Code',
            read_only: true,
            read_only_reason: 'structural',
            effective_layer: 'defaults',
            layers: [{ layer: 'defaults', source: null, is_set: true, value: 'Omni Code' }],
          },
          {
            ...baseField,
            key: 'security.safety_mode',
            type: 'string',
            label: 'Safety mode',
            value: 'recommended',
            reload: 'session',
            allowed_values: ['recommended', 'enforced', 'off'],
            layers: [{ layer: 'project', source: '/app/project.yml', is_set: true, value: 'recommended' }],
          },
          {
            ...baseField,
            key: 'security.blocked_tools',
            type: 'string_list',
            label: 'Blocked tools',
            value: ['shell', 'browser'],
            layers: [{ layer: 'project', source: '/app/project.yml', is_set: true, value: ['shell', 'browser'] }],
          },
          {
            ...baseField,
            key: 'security.audit.retention_days',
            type: 'integer',
            label: 'Audit retention',
            value: 30,
            minimum: 0,
            maximum: 365,
            layers: [{ layer: 'project', source: '/app/project.yml', is_set: true, value: 30 }],
          },
          {
            ...baseField,
            key: 'security.providers.auth.token',
            type: 'string',
            label: 'Auth token',
            secret: true,
            effective_layer: 'user',
            layers: [{ layer: 'user', source: writeTarget, is_set: true }],
          },
          {
            ...baseField,
            key: 'tracing.project',
            type: 'string',
            label: 'Tracing project',
            value: 'existing',
            effective_layer: 'user',
            layers: [
              { layer: 'project', source: '/app/project.yml', is_set: true, value: 'inherited' },
              { layer: 'user', source: writeTarget, is_set: true, value: 'existing' },
            ],
          },
        ],
      },
    },
  } as ManagementSnapshot;
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => root.render(<SettingsModalRuntimePolicyTab />));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
  );
  if (!result) {
    throw new Error(`Button not found: ${label}`);
  }
  return result;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.snapshot = snapshot();
  mocks.refresh.mockResolvedValue(mocks.snapshot);
  mocks.validateConfig.mockResolvedValue({
    valid: true,
    errors: [],
    reload: { hot: [], session: [], restart: [] },
  });
  mocks.writeConfig.mockResolvedValue({
    ok: true,
    errors: [],
    written: [],
    cleared: [],
    reload: { hot: [], session: [], restart: [] },
    restart_required: false,
    fields: [],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('SettingsModalRuntimePolicyTab', () => {
  it('renders server-described controls, provenance, reload classes, and redacted secret state', () => {
    render();

    expect(container.textContent).toContain('Runtime policy');
    expect(container.textContent).toContain('Next session');
    expect(container.textContent).toContain('Restart required');
    expect(container.textContent).toContain('Built-in default');
    expect(container.textContent).toContain('Defined by the product');
    expect(container.textContent).toContain('Secret set');
    expect((container.querySelector('#runtime-policy-security-safety_mode') as HTMLSelectElement).value).toBe(
      'recommended'
    );
    expect((container.querySelector('#runtime-policy-security-blocked_tools') as HTMLTextAreaElement).value).toBe(
      'shell\nbrowser'
    );
    expect((container.querySelector('#runtime-policy-security-audit-retention_days') as HTMLInputElement).value).toBe(
      '30'
    );
    const secret = container.querySelector('#runtime-policy-security-providers-auth-token') as HTMLInputElement;
    expect(secret.type).toBe('password');
    expect(secret.value).toBe('');
  });

  it('validates the complete pending batch before one atomic write and refetches', async () => {
    render();
    act(() => {
      setValue(container.querySelector('#runtime-policy-security-safety_mode') as HTMLSelectElement, 'enforced');
      setValue(container.querySelector('#runtime-policy-security-audit-retention_days') as HTMLInputElement, '45');
      setValue(
        container.querySelector('#runtime-policy-security-providers-auth-token') as HTMLInputElement,
        'new-token'
      );
    });
    act(() => button('Validate & save').click());
    await settle();

    const updates = {
      'security.safety_mode': 'enforced',
      'security.audit.retention_days': 45,
      'security.providers.auth.token': 'new-token',
    };
    expect(mocks.validateConfig).toHaveBeenCalledWith(updates);
    expect(mocks.writeConfig).toHaveBeenCalledWith(updates);
    expect(mocks.validateConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeConfig.mock.invocationCallOrder[0]!
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('shows server validation errors and never writes an invalid batch', async () => {
    mocks.validateConfig.mockResolvedValue({
      valid: false,
      errors: [{ key: 'tracing.project', code: 'invalid_value', message: 'Project is not allowed' }],
      reload: { hot: [], session: [], restart: [] },
    });
    render();
    act(() => setValue(container.querySelector('#runtime-policy-tracing-project') as HTMLInputElement, 'blocked'));
    act(() => button('Validate & save').click());
    await settle();

    expect(mocks.writeConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Project is not allowed');
    expect(container.textContent).toContain('Nothing was written');
  });

  it('sends null to clear only the GUI-owned overlay value', async () => {
    render();
    act(() => button('Reset Tracing project').click());
    expect(container.textContent).toContain('Will reset to the inherited value when saved.');
    act(() => button('Validate & save').click());
    await settle();

    expect(mocks.validateConfig).toHaveBeenCalledWith({ 'tracing.project': null });
    expect(mocks.writeConfig).toHaveBeenCalledWith({ 'tracing.project': null });
  });
});
