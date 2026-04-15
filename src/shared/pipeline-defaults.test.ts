/**
 * Tests for pipeline-defaults.ts — structural validation of default pipelines.
 * Ensures the pipelines that ship with GA have valid structure.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_PIPELINE, SIMPLE_PIPELINE } from '@/shared/pipeline-defaults';

describe('DEFAULT_PIPELINE', () => {
  it('has at least 2 columns', () => {
    expect(DEFAULT_PIPELINE.columns.length).toBeGreaterThanOrEqual(2);
  });

  it('every column has an id and label', () => {
    for (const col of DEFAULT_PIPELINE.columns) {
      expect(col.id).toBeTruthy();
      expect(col.label).toBeTruthy();
    }
  });

  it('column ids are unique', () => {
    const ids = DEFAULT_PIPELINE.columns.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('starts with backlog and ends with completed', () => {
    expect(DEFAULT_PIPELINE.columns[0]!.id).toBe('backlog');
    expect(DEFAULT_PIPELINE.columns[DEFAULT_PIPELINE.columns.length - 1]!.id).toBe('completed');
  });

  it('has a gated review column', () => {
    const review = DEFAULT_PIPELINE.columns.find((c) => c.id === 'review');
    expect(review).toBeDefined();
    expect(review!.gate).toBe(true);
  });
});

describe('SIMPLE_PIPELINE', () => {
  it('has 3 columns', () => {
    expect(SIMPLE_PIPELINE.columns).toHaveLength(3);
  });

  it('every column has an id and label', () => {
    for (const col of SIMPLE_PIPELINE.columns) {
      expect(col.id).toBeTruthy();
      expect(col.label).toBeTruthy();
    }
  });

  it('starts with backlog and ends with done', () => {
    expect(SIMPLE_PIPELINE.columns[0]!.id).toBe('backlog');
    expect(SIMPLE_PIPELINE.columns[SIMPLE_PIPELINE.columns.length - 1]!.id).toBe('done');
  });
});
