import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ResidentAgent, ResidentAgentRuntime } from '@/shared/types';

import type { AgentPresence } from './agent-avatar';
import { AgentAvatar, participantPresence, presenceStatus } from './agent-avatar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Fluent is deliberately NOT mocked: the presence treatment IS the real
// Avatar + PresenceBadge wiring (glyph per status, aria-labelledby that folds
// the status into the avatar's accessible name). Mocking it would test a stub.

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

/** Every presence dot Fluent painted, in DOM order. */
const badges = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.fui-PresenceBadge')];
const badgeLabels = (): (string | null)[] => badges().map((b) => b.getAttribute('aria-label'));
const avatars = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.fui-Avatar')];

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
  it('paints no dot and stays decorative when presence is not supplied', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" />);
    expect(badges()).toHaveLength(0);
    expect(avatars()[0]?.getAttribute('aria-hidden')).toBe('true');
  });

  it.each([
    ['available', 'available'],
    ['busy', 'busy'],
    ['offline', 'offline'],
  ] as const)('paints the %s dot with a matching accessible label', (presence, label) => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" presence={presence} />);
    expect(badgeLabels()).toEqual([label]);
  });

  it('folds the status into the avatar accessible name instead of hiding it', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" presence="busy" />);
    const avatar = avatars()[0];
    const badge = badges()[0];
    // The badge must not be behind aria-hidden — status has to reach AT.
    expect(avatar?.getAttribute('aria-hidden')).toBeNull();
    expect(avatar?.getAttribute('aria-labelledby')?.split(' ')).toContain(badge?.id);
    expect(avatar?.getAttribute('aria-label')).toBe('Ada Lovelace');
  });

  it('distinguishes statuses by glyph, not by colour alone', () => {
    const glyphFor = (presence: AgentPresence): string | null => {
      render(<AgentAvatar name="Ada Lovelace" colorId="a1" presence={presence} />);
      return host.querySelector('.fui-PresenceBadge__icon svg path')?.getAttribute('d') ?? null;
    };
    const shapes = [glyphFor('available'), glyphFor('busy'), glyphFor('offline')];
    expect(shapes.every((d) => typeof d === 'string' && d.length > 0)).toBe(true);
    expect(new Set(shapes).size).toBe(3);
  });

  it('keeps the initials fallback alongside the dot', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" presence="available" />);
    expect(host.querySelector('.fui-Avatar__initials')?.textContent).toBe('AL');
  });

  it('shrinks the dot on small avatars so it does not swallow them', () => {
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" presence="available" size={20} />);
    const small = host.querySelector('.fui-PresenceBadge__icon svg')?.getAttribute('width');
    render(<AgentAvatar name="Ada Lovelace" colorId="a1" presence="available" size={40} />);
    const large = host.querySelector('.fui-PresenceBadge__icon svg')?.getAttribute('width');
    expect(Number(small)).toBeGreaterThan(0);
    expect(Number(small)).toBeLessThan(Number(large));
  });

  it('repaints every mounted instance when the shared status changes', () => {
    // Stands in for the sidebar row, a feed gutter and a header band all
    // reading the same `$residentStatus` entry.
    const surfaces = (presence: AgentPresence): React.ReactNode => (
      <>
        <AgentAvatar name="Ada Lovelace" colorId="a1" presence={presence} size={20} />
        <AgentAvatar name="Ada Lovelace" colorId="a1" presence={presence} size={32} />
        <AgentAvatar name="Ada Lovelace" colorId="a1" presence={presence} size={40} />
      </>
    );

    render(surfaces('offline'));
    expect(badgeLabels()).toEqual(['offline', 'offline', 'offline']);

    render(surfaces('busy'));
    expect(badgeLabels()).toEqual(['busy', 'busy', 'busy']);

    render(surfaces('available'));
    expect(badgeLabels()).toEqual(['available', 'available', 'available']);
  });

  it('drives that repaint straight from a runtime state change', () => {
    const a = agent();
    render(<AgentAvatar name={a.name} colorId={a.id} presence={presenceStatus(runtime('idle').state, a.enabled)} />);
    expect(badgeLabels()).toEqual(['available']);

    render(
      <AgentAvatar name={a.name} colorId={a.id} presence={presenceStatus(runtime('thinking').state, a.enabled)} />
    );
    expect(badgeLabels()).toEqual(['busy']);

    render(<AgentAvatar name={a.name} colorId={a.id} presence={presenceStatus(runtime('idle').state, false)} />);
    expect(badgeLabels()).toEqual(['offline']);
  });
});
