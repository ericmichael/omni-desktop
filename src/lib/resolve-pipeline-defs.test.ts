import { describe, expect, it } from 'vitest';

import { resolvePipelineDefs } from '@/lib/resolve-pipeline-defs';

describe('resolvePipelineDefs', () => {
  it('seeds DEFAULT_COLUMNS for source projects when SQLite is empty', () => {
    const defs = resolvePipelineDefs({
      hasSource: true,
      hasExisting: false,
    });
    expect(defs).not.toBeNull();
    expect(defs!.map((d) => d.logicalId)).toEqual(['backlog', 'spec', 'implementation', 'review', 'pr', 'completed']);
    expect(defs!.find((d) => d.logicalId === 'review')!.gate).toBe(true);
    expect(defs!.find((d) => d.logicalId === 'spec')!.workflow).toMatchObject({
      purpose: expect.stringContaining('decision-complete'),
      definitionOfDone: expect.arrayContaining([expect.stringContaining('plan')]),
      recommendedSkills: expect.arrayContaining(['software-planning']),
    });
  });

  it('seeds SIMPLE_COLUMNS for sourceless projects when SQLite is empty', () => {
    const defs = resolvePipelineDefs({
      hasSource: false,
      hasExisting: false,
    });
    expect(defs!.map((d) => d.logicalId)).toEqual(['backlog', 'review', 'completed']);
    expect(defs!.find((d) => d.logicalId === 'review')!.gate).toBe(true);
  });

  it('returns null when SQLite has columns to preserve the project database pipeline', () => {
    expect(resolvePipelineDefs({ hasSource: true, hasExisting: true })).toBeNull();
  });
});
