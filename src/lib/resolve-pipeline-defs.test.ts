import { describe, expect, it } from 'vitest';

import { resolvePipelineDefs } from '@/lib/resolve-pipeline-defs';

describe('resolvePipelineDefs', () => {
  it('returns FLEET.md columns when present', () => {
    const defs = resolvePipelineDefs({
      hasSource: true,
      hasExisting: false,
      workflow: {
        pipeline: {
          columns: [
            { id: 'triage', label: 'Triage' },
            { id: 'shipped', label: 'Shipped' },
          ],
        },
      },
    });
    expect(defs).toEqual([
      { logicalId: 'triage', label: 'Triage', gate: undefined },
      { logicalId: 'shipped', label: 'Shipped', gate: undefined },
    ]);
  });

  it('FLEET.md wins even when SQLite has existing rows', () => {
    const defs = resolvePipelineDefs({
      hasSource: true,
      hasExisting: true,
      workflow: {
        pipeline: {
          columns: [{ id: 'only', label: 'Only' }],
        },
      },
    });
    expect(defs).toEqual([{ logicalId: 'only', label: 'Only', gate: undefined }]);
  });

  it('seeds DEFAULT_COLUMNS for source projects when SQLite is empty and no FLEET.md', () => {
    const defs = resolvePipelineDefs({
      hasSource: true,
      hasExisting: false,
      workflow: null,
    });
    expect(defs).not.toBeNull();
    expect(defs!.map((d) => d.logicalId)).toEqual([
      'backlog',
      'spec',
      'implementation',
      'review',
      'pr',
      'completed',
    ]);
    expect(defs!.find((d) => d.logicalId === 'review')!.gate).toBe(true);
  });

  it('seeds SIMPLE_COLUMNS for sourceless projects when SQLite is empty and no FLEET.md', () => {
    const defs = resolvePipelineDefs({
      hasSource: false,
      hasExisting: false,
      workflow: null,
    });
    expect(defs!.map((d) => d.logicalId)).toEqual(['backlog', 'active', 'done']);
  });

  it('returns null when SQLite has columns and FLEET.md is absent — leaves existing rows alone', () => {
    expect(
      resolvePipelineDefs({ hasSource: true, hasExisting: true, workflow: null })
    ).toBeNull();
  });

  it('returns null when SQLite has columns and FLEET.md has no pipeline section', () => {
    expect(
      resolvePipelineDefs({
        hasSource: true,
        hasExisting: true,
        workflow: { supervisor: { max_concurrent: 2 } }, // no pipeline section
      })
    ).toBeNull();
  });

  it('returns null when SQLite has columns and FLEET.md pipeline is empty', () => {
    expect(
      resolvePipelineDefs({
        hasSource: true,
        hasExisting: true,
        workflow: { pipeline: { columns: [] } },
      })
    ).toBeNull();
  });
});
