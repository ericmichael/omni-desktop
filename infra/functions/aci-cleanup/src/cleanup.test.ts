import { describe, expect, it } from 'vitest';

import { selectVictims, type GroupSummary } from './cleanup';

const RG = 'omni-launcher-rg';
const NOW = new Date('2026-05-28T18:00:00Z');

const group = (name: string, tags: Record<string, string> | null = {}): GroupSummary => ({
  name,
  tags,
});

const hoursAgo = (h: number): string =>
  new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

describe('selectVictims', () => {
  it('deletes groups tagged with the matching launcher and older than the cutoff', () => {
    const result = selectVictims(
      [
        group('alpha', { 'omni-launcher': RG, 'omni-created-at': hoursAgo(12) }),
        group('beta', { 'omni-launcher': RG, 'omni-created-at': hoursAgo(20) }),
      ],
      { launcherTag: RG, maxAgeHours: 8, now: NOW },
    );
    expect(result).toMatchObject({
      total: 2,
      deleted: ['alpha', 'beta'],
      skipped: [],
    });
  });

  it('keeps groups newer than the cutoff', () => {
    const result = selectVictims(
      [group('fresh', { 'omni-launcher': RG, 'omni-created-at': hoursAgo(1) })],
      { launcherTag: RG, maxAgeHours: 8, now: NOW },
    );
    expect(result.deleted).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ name: 'fresh' });
    expect(result.skipped[0]?.reason).toMatch(/younger than 8h/);
  });

  it('skips groups not tagged with our launcher (foreign workloads)', () => {
    const result = selectVictims(
      [
        group('mine', { 'omni-launcher': RG, 'omni-created-at': hoursAgo(20) }),
        group('theirs', { 'omni-launcher': 'someone-else', 'omni-created-at': hoursAgo(99) }),
        group('untagged', null),
        group('partially-tagged', { 'omni-session-id': 'x' }),
      ],
      { launcherTag: RG, maxAgeHours: 8, now: NOW },
    );
    expect(result.deleted).toEqual(['mine']);
    expect(result.skipped.map((s) => s.name).sort()).toEqual([
      'partially-tagged',
      'theirs',
      'untagged',
    ]);
  });

  it('skips groups with a missing or unparseable created-at tag (do not delete what we cannot age)', () => {
    const result = selectVictims(
      [
        group('no-ts', { 'omni-launcher': RG }),
        group('bad-ts', { 'omni-launcher': RG, 'omni-created-at': 'not-a-date' }),
      ],
      { launcherTag: RG, maxAgeHours: 8, now: NOW },
    );
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]?.reason).toMatch(/missing omni-created-at/);
    expect(result.skipped[1]?.reason).toMatch(/unparseable omni-created-at/);
  });

  it('treats exactly-at-cutoff as still fresh (>cutoff is the predicate, equal is kept)', () => {
    const result = selectVictims(
      [group('edge', { 'omni-launcher': RG, 'omni-created-at': hoursAgo(8) })],
      { launcherTag: RG, maxAgeHours: 8, now: NOW },
    );
    // hoursAgo(8) == cutoff exactly; ts === cutoff, ts > cutoff is false → deleted.
    expect(result.deleted).toEqual(['edge']);
  });

  it('honours OMNI_LAUNCHER_TAG override (separate fleets in the same RG)', () => {
    const result = selectVictims(
      [
        group('fleet-a', { 'omni-launcher': 'fleet-a', 'omni-created-at': hoursAgo(20) }),
        group('fleet-b', { 'omni-launcher': 'fleet-b', 'omni-created-at': hoursAgo(20) }),
      ],
      { launcherTag: 'fleet-a', maxAgeHours: 8, now: NOW },
    );
    expect(result.deleted).toEqual(['fleet-a']);
  });
});
