import { describe, expect, it } from 'vitest';

import { columnToRow, rowToColumn } from '@/main/db-store-bridge';

import type { ColumnRow } from 'omni-projects-db';

describe('pipeline column row mapping', () => {
  const baseRow: ColumnRow = {
    id: 'proj_1__spec',
    project_id: 'proj_1',
    label: 'Spec',
    description: 'Plan the work',
    sort_order: 1,
    gate: 0,
    max_concurrent: 2,
    workflow: JSON.stringify({
      purpose: 'Plan the implementation',
      definitionOfDone: ['Decision-complete plan exists'],
      agentInstructions: 'Use software-planning.',
      recommendedSkills: ['software-planning'],
    }),
  };

  it('maps workflow metadata and max concurrency from rows', () => {
    expect(rowToColumn(baseRow)).toEqual({
      id: 'proj_1__spec',
      label: 'Spec',
      description: 'Plan the work',
      maxConcurrent: 2,
      workflow: {
        purpose: 'Plan the implementation',
        definitionOfDone: ['Decision-complete plan exists'],
        agentInstructions: 'Use software-planning.',
        recommendedSkills: ['software-planning'],
      },
    });
  });

  it('ignores malformed workflow JSON safely', () => {
    expect(rowToColumn({ ...baseRow, workflow: '{nope' }).workflow).toBeUndefined();
  });

  it('maps workflow metadata and max concurrency to rows', () => {
    expect(columnToRow(rowToColumn(baseRow), 'proj_1', 1)).toMatchObject({
      max_concurrent: 2,
      workflow: baseRow.workflow,
    });
  });
});
