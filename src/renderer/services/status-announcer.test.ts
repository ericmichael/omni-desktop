import { describe, expect, it } from 'vitest';

import type { ColumnActivity } from '@/renderer/services/column-activity';
import { buildAnnouncements } from '@/renderer/services/status-announcer';

const label = (scope: string) => `Col ${scope}`;

const activity = (overrides: Partial<ColumnActivity>): ColumnActivity => ({
  thinking: false,
  text: null,
  pendingApproval: false,
  ...overrides,
});

describe('buildAnnouncements', () => {
  it('announces a column starting to wait for approval', () => {
    const prev = { a: activity({ thinking: true }) };
    const next = { a: activity({ thinking: true, pendingApproval: true }) };
    expect(buildAnnouncements(prev, next, label)).toEqual(['Col a: waiting for your approval']);
  });

  it('announces a finished run', () => {
    const prev = { a: activity({ thinking: true }) };
    const next = { a: activity({ thinking: false }) };
    expect(buildAnnouncements(prev, next, label)).toEqual(['Col a: finished']);
  });

  it('does not announce a run start', () => {
    const prev = { a: activity({}) };
    const next = { a: activity({ thinking: true, text: 'Working…' }) };
    expect(buildAnnouncements(prev, next, label)).toEqual([]);
  });

  it('does not re-announce a held approval', () => {
    const prev = { a: activity({ pendingApproval: true }) };
    const next = { a: activity({ pendingApproval: true, text: 'still waiting' }) };
    expect(buildAnnouncements(prev, next, label)).toEqual([]);
  });

  it('prefers the approval message when a run ends into an approval', () => {
    const prev = { a: activity({ thinking: true }) };
    const next = { a: activity({ thinking: false, pendingApproval: true }) };
    expect(buildAnnouncements(prev, next, label)).toEqual(['Col a: waiting for your approval']);
  });

  it('handles multiple columns transitioning at once', () => {
    const prev = { a: activity({ thinking: true }), b: activity({}) };
    const next = {
      a: activity({ thinking: false }),
      b: activity({ pendingApproval: true }),
    };
    expect(buildAnnouncements(prev, next, label)).toEqual(['Col a: finished', 'Col b: waiting for your approval']);
  });

  it('announces a brand-new column that appears already waiting', () => {
    const next = { a: activity({ pendingApproval: true }) };
    expect(buildAnnouncements({}, next, label)).toEqual(['Col a: waiting for your approval']);
  });
});
