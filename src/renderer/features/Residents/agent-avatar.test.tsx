import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SidebarProvider } from '@/renderer/ds/ui/sidebar';
import { persistedStoreApi } from '@/renderer/services/store';
import type { ResidentAgent, ResidentAgentRuntime, StoreData } from '@/shared/types';

import { AgentAvatar, AgentAvatarGroup, participantPresence, presenceStatus } from './agent-avatar';
import { DmsSection } from './sidebar-sections';
import { $residentStatus, $residentsView } from './state';

// `./state` and `services/store` dial IPC at import time; the sidebar section
// below is mounted for real, so the transport is the only thing stubbed. The
// `store:changed` handler is captured so the store can be seeded through the
// SAME path main uses, rather than by poking the private atom.
//
// `DmsSection` and friends are imported STATICALLY on purpose. `vi.mock` is
// hoisted above these imports, so the stub is in place before they evaluate —
// and pulling `sidebar-sections` (which reaches the whole `@/renderer/ds`
// barrel) costs ~3.4s of one-time Vite transform. As a dynamic `await import()`
// inside a test that lands in the 5s per-test budget and times out on CI; as a
// static import it is paid once during collection, which has no such limit.
// Tests here run in ~170ms total. Do not convert these back to dynamic imports.
const mocks = vi.hoisted(() => ({ ipcHandlers: new Map<string, (data: unknown) => void>() }));

vi.mock('@/renderer/services/ipc', () => ({
  emitter: { invoke: vi.fn(() => Promise.resolve({})), send: vi.fn() },
  localEmitter: { invoke: vi.fn(() => Promise.resolve({})), send: vi.fn() },
  ipc: {
    on: vi.fn((channel: string, cb: (data: unknown) => void) => {
      mocks.ipcHandlers.set(channel, cb);
      return () => {};
    }),
  },
  wsEmitter: { on: vi.fn(() => () => {}), onConnect: vi.fn(() => () => {}) },
  isElectron: false,
  isCloudLinked: false,
  isWslLinked: false,
  isServerLinked: false,
  bootstrapPlatform: 'linux',
  serverOrigin: () => 'http://localhost',
  serverWsOrigin: () => 'ws://localhost',
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The shadcn avatar and presence treatment are rendered for real. Mocking them
// would only test a stub.

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (node: React.ReactNode): void => {
  act(() => root.render(node));
};

const badges = (scope: ParentNode = host): HTMLElement[] => [
  ...scope.querySelectorAll<HTMLElement>('[data-slot="presence-badge"]'),
];
const badgeLabels = (scope: ParentNode = host): (string | null)[] =>
  badges(scope).map((b) => b.getAttribute('aria-label'));
const avatars = (scope: ParentNode = host): HTMLElement[] => [
  ...scope.querySelectorAll<HTMLElement>('[data-slot="avatar-shell"]'),
];
/** The off-screen span carrying the presence word. */
const statusSpan = (scope: ParentNode = host): HTMLElement => {
  const span = [...scope.querySelectorAll<HTMLElement>('span')].find(
    (el) => el.children.length === 0 && ['available', 'busy', 'offline'].includes(el.textContent ?? '')
  );
  if (!span) {
    throw new Error('no presence status text rendered');
  }
  return span;
};

const first = (els: HTMLElement[]): Element => {
  const el = els[0];
  if (!el) {
    throw new Error('expected at least one element');
  }
  return el;
};

// ---------------------------------------------------------------------------
// Accessible-name helper
// ---------------------------------------------------------------------------

/**
 * The slice of the accname algorithm these surfaces exercise: aria-labelledby
 * → aria-label → name from content, skipping `aria-hidden` subtrees. Enough to
 * prove a row announces the agent once and its status once; not a general
 * implementation. `viaLabelledby` goes false when resolving a labelledby
 * target, which is how the spec avoids the self-reference the avatar
 * emits (`aria-labelledby="<self> <badge>"`).
 */
const accessibleName = (el: Element, viaLabelledby = true): string => {
  if (viaLabelledby) {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      return ids
        .split(/\s+/)
        .map((id) => {
          const target = el.ownerDocument.getElementById(id);
          return target ? accessibleName(target, false) : '';
        })
        .filter(Boolean)
        .join(' ');
    }
  }
  const label = el.getAttribute('aria-label');
  if (label) {
    return label;
  }
  const parts: string[] = [];
  el.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      const text = node.textContent?.trim();
      if (text) {
        parts.push(text);
      }
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const child = node as Element;
    if (child.getAttribute('aria-hidden') === 'true') {
      return;
    }
    const name = accessibleName(child);
    if (name) {
      parts.push(name);
    }
  });
  return parts.join(' ');
};

describe('accessibleName (test helper)', () => {
  const parse = (html: string): Element => {
    host.innerHTML = html;
    const el = host.firstElementChild;
    if (!el) {
      throw new Error('no element');
    }
    return el;
  };

  it('names a widget from its content', () => {
    expect(accessibleName(parse('<button><span>Ada</span><span>Engineer</span></button>'))).toBe('Ada Engineer');
  });

  it('lets an explicit aria-label win over the subtree', () => {
    expect(accessibleName(parse('<button aria-label="Open session"><span>Ada</span></button>'))).toBe('Open session');
  });

  it('skips aria-hidden subtrees', () => {
    expect(accessibleName(parse('<button><span aria-hidden="true">AL</span><span>Ada</span></button>'))).toBe('Ada');
  });

  it('folds a labelled img descendant into the name', () => {
    expect(accessibleName(parse('<button><span role="img" aria-label="busy"></span><span>Ada</span></button>'))).toBe(
      'busy Ada'
    );
  });

  it('resolves aria-labelledby self-references', () => {
    expect(
      accessibleName(
        parse('<span id="a" role="img" aria-label="Ada" aria-labelledby="a b"><i id="b" aria-label="busy"></i></span>')
      )
    ).toBe('Ada busy');
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const agent = (over: Partial<ResidentAgent> = {}): ResidentAgent =>
  ({ id: 'a1', name: 'Ada Lovelace', role: 'Engineer', enabled: true, ...over }) as ResidentAgent;

const runtime = (state: ResidentAgentRuntime['state']): ResidentAgentRuntime => ({
  state,
  lastWakeupAt: null,
  lastReason: null,
  day: null,
  pendingCount: 0,
  decisions: 0,
});

// ---------------------------------------------------------------------------

describe('presenceStatus', () => {
  it.each([
    ['starting', 'busy'],
    ['thinking', 'busy'],
    ['reflecting', 'busy'],
    ['idle', 'available'],
    ['parked', 'offline'],
  ] as const)('maps %s to %s', (state, expected) => {
    expect(presenceStatus(state)).toBe(expected);
  });

  it('reads an agent with no runtime entry as offline, not as a fourth state', () => {
    expect(presenceStatus(undefined)).toBe('offline');
  });

  it('forces offline for a disabled agent whatever the runtime says', () => {
    expect(presenceStatus('thinking', false)).toBe('offline');
    expect(presenceStatus('idle', false)).toBe('offline');
  });
});

describe('participantPresence', () => {
  const roster = [agent(), agent({ id: 'a2', name: 'Grace', enabled: false })];
  const statuses = { a1: runtime('thinking'), a2: runtime('idle') };

  it('resolves a roster agent through the shared mapping', () => {
    expect(participantPresence('a1', roster, statuses)).toBe('busy');
  });

  it('honours the enabled flag over the runtime state', () => {
    expect(participantPresence('a2', roster, statuses)).toBe('offline');
  });

  it.each(['user', 'system', 'a-departed-agent'])('reports no presence for the non-agent participant %s', (id) => {
    expect(participantPresence(id, roster, statuses)).toBeUndefined();
  });
});

describe('AgentAvatar', () => {
  it('renders initials without a status when presence is omitted', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={32} />);
    expect(badges()).toHaveLength(0);
    expect(host.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe('AL');
  });

  it.each(['available', 'busy', 'offline'] as const)('renders an accessible, shape-distinct %s status', (presence) => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={32} presence={presence} />);
    expect(badgeLabels()).toEqual([presence]);
    expect(host.textContent).toContain(presence);
    expect(badges()[0]?.querySelector('svg')).toBeTruthy();
  });

  it('keeps status text reachable to assistive technology while visually hidden', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={20} presence="busy" />);
    const span = statusSpan();
    expect(span.classList.contains('sr-only')).toBe(true);
  });

  it('keeps the avatar mark decorative when the adjacent row already names the agent', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={32} presence="busy" />);
    expect(first(avatars()).getAttribute('aria-hidden')).toBe('true');
  });

  it('honors explicit compact avatar sizes', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={20} presence="busy" />);
    const avatar = host.querySelector<HTMLElement>('[data-slot="avatar"]');
    expect(avatar?.classList.contains('size-5')).toBe(true);
  });
});

describe('AgentAvatarGroup', () => {
  const pair = [
    { name: 'Ada', colorId: 'a1', presence: 'busy' as const },
    { name: 'Grace', colorId: 'a2', presence: 'available' as const },
  ];

  it('shows status for both agents without stacking them', () => {
    render(<AgentAvatarGroup avatars={pair} size={24} />);
    expect(badgeLabels()).toEqual(['busy', 'available']);
    expect(host.querySelector('[class*="gap-1"]')).toBeTruthy();
  });

  it('names each agent in the shared off-screen status text', () => {
    render(<AgentAvatarGroup avatars={pair} size={24} />);
    expect(accessibleName(host)).toBe('Ada busy, Grace available');
    const span = [...host.querySelectorAll<HTMLElement>('span')].find(
      (node) => node.textContent === 'Ada busy, Grace available'
    );
    expect(span).toBeDefined();
    expect(span!.classList.contains('sr-only')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real surface: the sidebar DM section, driven by the real $residentStatus.
// ---------------------------------------------------------------------------

const resident = (id: string, name: string, role: string): ResidentAgent => ({
  id,
  name,
  role,
  personaText: '',
  morningHour: null,
  enabled: true,
  createdAt: 0,
});

const seed = (statuses: Record<string, ResidentAgentRuntime>): void => {
  const next: StoreData = {
    ...persistedStoreApi.$atom.get(),
    layoutMode: 'agents',
    residentAgents: [resident('a1', 'Ada Lovelace', 'Engineer'), resident('a2', 'Grace Hopper', 'Compilers')],
    residentChannels: [
      { id: 1, channel: 'dm:a1:user', from: 'a1', text: 'hi', at: 2 },
      { id: 2, channel: 'dm:a2:user', from: 'a2', text: 'yo', at: 1 },
    ],
  };
  act(() => mocks.ipcHandlers.get('store:changed')?.(next));
  $residentsView.set({ ...$residentsView.get(), selectedChannel: null });
  $residentStatus.set(statuses);
};

const setStatus = (statuses: Record<string, ResidentAgentRuntime>): void => {
  act(() => $residentStatus.set(statuses));
};

/** The mounted DM nav rows, keyed by the agent name they show. */
const rowsByAgent = (): Record<string, HTMLElement[]> => {
  const out: Record<string, HTMLElement[]> = {};
  for (const item of host.querySelectorAll<HTMLElement>('[data-sidebar="menu-item"]')) {
    const button = item.querySelector<HTMLElement>('[data-sidebar="menu-button"]');
    const key = ['Ada Lovelace', 'Grace Hopper'].find((name) => button?.textContent?.includes(name));
    if (key) {
      (out[key] ??= []).push(item);
    }
  }
  return out;
};

describe('sidebar DM rows (real DmsSection + real $residentStatus)', () => {
  it('announces the agent once and its status once', () => {
    seed({ a1: runtime('thinking'), a2: runtime('idle') });
    render(
      <SidebarProvider>
        <DmsSection />
      </SidebarProvider>
    );

    const ada = rowsByAgent()['Ada Lovelace']?.[0];
    expect(ada).toBeDefined();
    const name = accessibleName(ada as Element);
    // The row also carries an unread counter, so assert multiplicity: the
    // agent is named once and the status announced once.
    expect(name).toContain('busy');
    expect(name).toContain('Ada Lovelace');
    expect(name.match(/Ada Lovelace/g)).toHaveLength(1);
    expect(name.match(/busy/g)).toHaveLength(1);
  });

  it('repaints every mounted instance when $residentStatus changes, with no re-render', () => {
    seed({ a1: runtime('parked'), a2: runtime('parked') });
    // Two independently mounted copies of the real section — the same agent
    // rendered on two surfaces at once.
    render(
      <SidebarProvider>
        <DmsSection />
        <DmsSection />
      </SidebarProvider>
    );

    const before = rowsByAgent();
    expect(before['Ada Lovelace']).toHaveLength(2);
    expect(before['Grace Hopper']).toHaveLength(2);
    for (const row of [...(before['Ada Lovelace'] ?? []), ...(before['Grace Hopper'] ?? [])]) {
      expect(badgeLabels(row)).toEqual(['offline']);
    }

    // No render() call here — only the store moves.
    setStatus({ a1: runtime('thinking'), a2: runtime('parked') });

    const after = rowsByAgent();
    expect(after['Ada Lovelace']).toHaveLength(2);
    for (const row of after['Ada Lovelace'] ?? []) {
      expect(badgeLabels(row)).toEqual(['busy']);
      const name = accessibleName(row);
      expect(name).toContain('busy');
      expect(name).toContain('Ada Lovelace');
      expect(name.match(/Ada Lovelace/g)).toHaveLength(1);
    }
    for (const row of after['Grace Hopper'] ?? []) {
      expect(badgeLabels(row)).toEqual(['offline']);
    }
    // Same DOM nodes — the rows updated in place rather than remounting.
    expect(after['Ada Lovelace']?.[0]).toBe(before['Ada Lovelace']?.[0]);

    setStatus({ a1: runtime('idle'), a2: runtime('idle') });
    for (const row of Object.values(rowsByAgent()).flat()) {
      expect(badgeLabels(row)).toEqual(['available']);
    }
  });
});
