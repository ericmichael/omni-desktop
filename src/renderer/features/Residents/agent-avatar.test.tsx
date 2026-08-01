import {
  Avatar,
  AvatarGroup,
  AvatarGroupItem,
  InteractionTag,
  InteractionTagPrimary,
} from '@fluentui/react-components';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { persistedStoreApi } from '@/renderer/services/store';
import type { ResidentAgent, ResidentAgentRuntime, StoreData } from '@/shared/types';

import type { AgentPresence } from './agent-avatar';
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

// Fluent is deliberately NOT mocked: the presence treatment IS the real
// Avatar + PresenceBadge wiring (glyph per status, size resolved off the
// ambient AvatarContext, layout margins). Mocking it would test a stub.

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  ...scope.querySelectorAll<HTMLElement>('.fui-PresenceBadge'),
];
const badgeLabels = (scope: ParentNode = host): (string | null)[] =>
  badges(scope).map((b) => b.getAttribute('aria-label'));
const avatars = (scope: ParentNode = host): HTMLElement[] => [...scope.querySelectorAll<HTMLElement>('.fui-Avatar')];
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

/** Griffel emits one atom class per resolved style plus a per-component
 *  sequence hash; only the atoms are comparable across different trees. */
const atomClasses = (el: Element): Set<string> =>
  new Set([...el.classList].filter((c) => /^f[a-z0-9]+$/.test(c) && !c.startsWith('fui')));

const difference = (a: Set<string>, b: Set<string>): Set<string> => new Set([...a].filter((c) => !b.has(c)));

// ---------------------------------------------------------------------------
// Accessible-name helper
// ---------------------------------------------------------------------------

/**
 * The slice of the accname algorithm these surfaces exercise: aria-labelledby
 * → aria-label → name from content, skipping `aria-hidden` subtrees. Enough to
 * prove a row announces the agent once and its status once; not a general
 * implementation. `viaLabelledby` goes false when resolving a labelledby
 * target, which is how the spec avoids the self-reference Fluent's Avatar
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

  it('resolves aria-labelledby, including Fluent self-references', () => {
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
  it('paints no dot and no status text when presence is not supplied', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={32} />);
    expect(badges()).toHaveLength(0);
    expect(host.textContent).toBe('AL');
  });

  it.each([
    ['available', 'available'],
    ['busy', 'busy'],
    ['offline', 'offline'],
  ] as const)('paints the %s dot with a matching status text', (presence, label) => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={32} presence={presence} />);
    expect(badgeLabels()).toEqual([label]);
    expect(host.textContent).toContain(label);
  });

  it('hides the status text in a way that KEEPS it in the accessibility tree', () => {
    // The whole D2/D3 fix rests on this one technique. `display: none` or
    // `visibility: hidden` would look identical on screen and identical in
    // every other assertion here, while silently deleting the status from
    // assistive tech — so pin both halves: off-screen, but still rendered.
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={20} presence="busy" />);
    const span = statusSpan();
    const style = getComputedStyle(span);

    // Still in the a11y tree.
    expect(style.display).not.toBe('none');
    expect(style.visibility).not.toBe('hidden');
    // Still off-screen — a "fix" that just shows the word is not a fix.
    expect(style.position).toBe('absolute');
    expect(style.width).toBe('1px');
    expect(style.height).toBe('1px');
  });

  it('keeps the mark itself decorative so a row never announces the agent twice', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={32} presence="busy" />);
    expect(first(avatars()).getAttribute('aria-hidden')).toBe('true');
  });

  it('distinguishes statuses by glyph, not by colour alone', () => {
    const glyphFor = (presence: AgentPresence): string | null => {
      render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={32} presence={presence} />);
      return host.querySelector('.fui-PresenceBadge__icon svg path')?.getAttribute('d') ?? null;
    };
    const shapes = [glyphFor('available'), glyphFor('busy'), glyphFor('offline')];
    expect(shapes.every((d) => typeof d === 'string' && d.length > 0)).toBe(true);
    expect(new Set(shapes).size).toBe(3);
  });

  it('keeps the initials fallback alongside the dot', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={32} presence="available" />);
    expect(host.querySelector('.fui-Avatar__initials')?.textContent).toBe('AL');
  });

  it('pins the badge to extra-small under 28px, where Fluent would drop to 6px tiny', () => {
    // Both badge sizes ship the same 10px glyph asset, so the box size only
    // shows up in the badge's own style atoms — compare against Fluent's
    // unpinned default at the same avatar size.
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={20} presence="busy" />);
    const pinned = atomClasses(first(badges()));

    render(<Avatar name="Ada Lovelace" size={20} badge={{ status: 'busy' }} />);
    const fluentDefault = atomClasses(first(badges()));
    render(<Avatar name="Ada Lovelace" size={20} badge={{ status: 'busy', size: 'extra-small' }} />);
    const extraSmall = atomClasses(first(badges()));

    expect(fluentDefault).not.toEqual(extraSmall); // the pin is not a no-op
    expect(pinned).toEqual(extraSmall);
  });

  it('leaves the badge to Fluent at 28px and above', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" size={40} presence="busy" />);
    const ours = atomClasses(first(badges()));
    render(<Avatar name="Ada Lovelace" size={40} badge={{ status: 'busy' }} />);
    expect(ours).toEqual(atomClasses(first(badges())));
  });
});

describe('AgentAvatar inside a Fluent slot', () => {
  /** Class atoms unique to each size, so the comparison is hash-agnostic. */
  const sizeAtoms = (): { only20: Set<string>; only32: Set<string> } => {
    render(<Avatar name="Ada Lovelace" size={20} />);
    const at20 = atomClasses(first(avatars()));
    render(<Avatar name="Ada Lovelace" size={32} />);
    const at32 = atomClasses(first(avatars()));
    return { only20: difference(at20, at32), only32: difference(at32, at20) };
  };

  const inSmallTag = (node: React.ReactElement): Set<string> => {
    render(
      <InteractionTag size="small" shape="circular">
        <InteractionTagPrimary media={node}>Ada</InteractionTagPrimary>
      </InteractionTag>
    );
    return atomClasses(first(avatars()));
  };

  it('inherits the 20px size InteractionTagPrimary publishes when none is given', () => {
    // Fluent resolves `props.size ?? avatarContextSize ?? 32`, so a hardcoded
    // default in AgentAvatar would silently beat the 20px context and burst
    // the 24px chip.
    const { only20, only32 } = sizeAtoms();
    const resolved = inSmallTag(<AgentAvatar name="Ada Lovelace" colorId="a1" presence="busy" />);

    expect(only20.size).toBeGreaterThan(0);
    for (const atom of only20) {
      expect(resolved).toContain(atom);
    }
    for (const atom of only32) {
      expect(resolved).not.toContain(atom);
    }
  });

  it('still pins the badge when the size comes from the context rather than a prop', () => {
    // The pin keys off the PROP, which is undefined here — so an unsized
    // avatar in a compact slot must not fall through to Fluent's 6px `tiny`.
    render(
      <InteractionTag size="small" shape="circular">
        <InteractionTagPrimary media={<AgentAvatar name="Ada Lovelace" colorId="a1" presence="busy" />}>
          Ada
        </InteractionTagPrimary>
      </InteractionTag>
    );
    const inherited = atomClasses(first(badges()));

    render(<Avatar name="Ada Lovelace" size={20} badge={{ status: 'busy', size: 'extra-small' }} />);
    const extraSmall = atomClasses(first(badges()));
    render(<Avatar name="Ada Lovelace" size={20} badge={{ status: 'busy' }} />);
    const tiny = atomClasses(first(badges()));

    expect(tiny).not.toEqual(extraSmall);
    expect(inherited).toEqual(extraSmall);
  });

  it('resolves the same 20px when the member chip asks for it explicitly', () => {
    const { only20, only32 } = sizeAtoms();
    const explicit = inSmallTag(<AgentAvatar name="Ada Lovelace" colorId="a1" size={20} presence="busy" />);
    for (const atom of only20) {
      expect(explicit).toContain(atom);
    }
    for (const atom of only32) {
      expect(explicit).not.toContain(atom);
    }
  });
});

describe('AgentAvatarGroup', () => {
  const pair = [
    { name: 'Ada', colorId: 'a1', presence: 'busy' as const },
    { name: 'Grace', colorId: 'a2', presence: 'available' as const },
  ];

  it('shows a dot for BOTH agents in an observed agent-to-agent thread', () => {
    render(<AgentAvatarGroup avatars={pair} size={24} />);
    expect(badgeLabels()).toEqual(['busy', 'available']);
  });

  it('lays out spread, not stacked — stacking clips the leading badge', () => {
    const groupAtoms = (layout: 'stack' | 'spread'): Set<string> => {
      render(
        <AvatarGroup layout={layout} size={24}>
          <AvatarGroupItem color="colorful" name="Ada" idForColor="a1" />
          <AvatarGroupItem color="colorful" name="Grace" idForColor="a2" />
        </AvatarGroup>
      );
      return atomClasses(first([...host.querySelectorAll<HTMLElement>('.fui-AvatarGroupItem')].slice(1)));
    };
    const stacked = groupAtoms('stack');
    const spread = groupAtoms('spread');
    expect(stacked).not.toEqual(spread);

    render(<AgentAvatarGroup avatars={pair} size={24} />);
    const ours = atomClasses(first([...host.querySelectorAll<HTMLElement>('.fui-AvatarGroupItem')].slice(1)));
    for (const atom of difference(spread, stacked)) {
      expect(ours).toContain(atom);
    }
    for (const atom of difference(stacked, spread)) {
      expect(ours).not.toContain(atom);
    }
  });

  it('names each agent in the status text, since a bare status could not say whose', () => {
    render(<AgentAvatarGroup avatars={pair} size={24} />);
    expect(accessibleName(host)).toBe('Ada busy, Grace available');
  });

  it('hides its status text the same reachable way', () => {
    render(<AgentAvatarGroup avatars={pair} size={24} />);
    const span = [...host.querySelectorAll<HTMLElement>('span')].find((el) => el.textContent?.includes('Ada busy'));
    expect(span).toBeDefined();
    const style = getComputedStyle(span as HTMLElement);
    expect(style.display).not.toBe('none');
    expect(style.visibility).not.toBe('hidden');
    expect(style.position).toBe('absolute');
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
  for (const item of host.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
    const key = item.querySelector('.fui-TreeItemLayout__main')?.textContent ?? '';
    (out[key] ??= []).push(item);
  }
  return out;
};

describe('sidebar DM rows (real DmsSection + real $residentStatus)', () => {
  it('announces the agent once and its status once', () => {
    seed({ a1: runtime('thinking'), a2: runtime('idle') });
    render(<DmsSection />);

    const ada = rowsByAgent()['Ada Lovelace']?.[0];
    expect(ada).toBeDefined();
    const name = accessibleName(ada as Element);
    // The row also carries an unread counter, so assert multiplicity: the
    // agent is named once and the status announced once.
    expect(name.startsWith('busy Ada Lovelace')).toBe(true);
    expect(name.match(/Ada Lovelace/g)).toHaveLength(1);
    expect(name.match(/busy/g)).toHaveLength(1);
  });

  it('would catch the duplicate-name regression an exposed avatar causes', () => {
    // Control: the shape this component deliberately does NOT render — an
    // Avatar left exposed folds BOTH its name and its badge into the row.
    render(
      <button type="button">
        <Avatar color="colorful" name="Ada Lovelace" idForColor="a1" size={20} badge={{ status: 'busy' }} />
        <span>Ada Lovelace</span>
      </button>
    );
    expect(accessibleName(host.querySelector('button') as Element)).toBe('Ada Lovelace busy Ada Lovelace');
  });

  it('repaints every mounted instance when $residentStatus changes, with no re-render', () => {
    seed({ a1: runtime('parked'), a2: runtime('parked') });
    // Two independently mounted copies of the real section — the same agent
    // rendered on two surfaces at once.
    render(
      <>
        <DmsSection />
        <DmsSection />
      </>
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
      expect(name.startsWith('busy Ada Lovelace')).toBe(true);
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
