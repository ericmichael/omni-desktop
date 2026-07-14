import { describe, expect, it } from 'vitest';

import {
  categoryOf,
  columnCategory,
  doneColumnIds,
  isDoneColumn,
  normalizePipelineCategories,
  positionalCategory,
  validatePipelineCategories,
} from '@/lib/pipeline-category';
import type { Column, Pipeline } from '@/shared/types';

const col = (id: string, category?: Column['category']): Column => ({
  id,
  label: id,
  ...(category ? { category } : {}),
});

const pipeline = (...columns: Column[]): Pipeline => ({ columns });

describe('positionalCategory', () => {
  it('maps first → todo, last → done, middle → doing', () => {
    expect(positionalCategory(0, 3)).toBe('todo');
    expect(positionalCategory(1, 3)).toBe('doing');
    expect(positionalCategory(2, 3)).toBe('done');
  });

  it('single-column pipelines land on done (last wins)', () => {
    expect(positionalCategory(0, 1)).toBe('done');
  });

  it('two-column pipelines are todo → done', () => {
    expect(positionalCategory(0, 2)).toBe('todo');
    expect(positionalCategory(1, 2)).toBe('done');
  });
});

describe('categoryOf / doneColumnIds / isDoneColumn', () => {
  const p = pipeline(col('a', 'todo'), col('b', 'doing'), col('c', 'done'));

  it('reads declared categories', () => {
    expect(categoryOf(p, 'a')).toBe('todo');
    expect(categoryOf(p, 'b')).toBe('doing');
    expect(categoryOf(p, 'c')).toBe('done');
  });

  it('falls back positionally for legacy columns without a category', () => {
    const legacy = pipeline(col('a'), col('b'), col('c'));
    expect(categoryOf(legacy, 'a')).toBe('todo');
    expect(categoryOf(legacy, 'b')).toBe('doing');
    expect(categoryOf(legacy, 'c')).toBe('done');
  });

  it('unknown column ids degrade to doing', () => {
    expect(categoryOf(p, 'ghost')).toBe('doing');
    expect(categoryOf(null, 'a')).toBe('doing');
  });

  it('collects done column ids', () => {
    expect(doneColumnIds(p)).toEqual(new Set(['c']));
    expect(doneColumnIds(undefined)).toEqual(new Set());
  });

  it('isDoneColumn matches only done-category columns', () => {
    expect(isDoneColumn(p, 'c')).toBe(true);
    expect(isDoneColumn(p, 'b')).toBe(false);
  });
});

describe('normalizePipelineCategories', () => {
  it('fills missing categories positionally and keeps declared ones', () => {
    const input = [col('a'), col('b', 'todo'), col('c')];
    const out = normalizePipelineCategories(input);
    expect(out.map((c) => c.category)).toEqual(['todo', 'todo', 'done']);
    // Declared category untouched, original objects not mutated
    expect(input[1]!.category).toBe('todo');
    expect(input[0]!.category).toBeUndefined();
  });
});

describe('validatePipelineCategories', () => {
  it('accepts todo* doing* done', () => {
    expect(
      validatePipelineCategories([col('a', 'todo'), col('b', 'doing'), col('c', 'doing'), col('d', 'done')]).isOk()
    ).toBe(true);
  });

  it('accepts minimal todo → done', () => {
    expect(validatePipelineCategories([col('a', 'todo'), col('b', 'done')]).isOk()).toBe(true);
  });

  it('rejects pipelines with no todo column', () => {
    const r = validatePipelineCategories([col('a', 'doing'), col('b', 'done')]);
    expect(r.isErr()).toBe(true);
  });

  it('rejects pipelines with no done column', () => {
    expect(validatePipelineCategories([col('a', 'todo'), col('b', 'doing')]).isErr()).toBe(true);
  });

  it('rejects more than one done column', () => {
    expect(validatePipelineCategories([col('a', 'todo'), col('b', 'done'), col('c', 'done')]).isErr()).toBe(true);
  });

  it('rejects done anywhere but last', () => {
    expect(validatePipelineCategories([col('a', 'todo'), col('b', 'done'), col('c', 'doing')]).isErr()).toBe(true);
  });

  it('rejects backwards category order (doing before todo)', () => {
    expect(validatePipelineCategories([col('a', 'doing'), col('b', 'todo'), col('c', 'done')]).isErr()).toBe(true);
  });

  it('validates legacy columns through the positional fallback', () => {
    // No declared categories at all → positional shape is always valid
    expect(validatePipelineCategories([col('a'), col('b'), col('c')]).isOk()).toBe(true);
  });
});

describe('columnCategory', () => {
  it('prefers the declared category over position', () => {
    expect(columnCategory(col('x', 'done'), 0, 3)).toBe('done');
    expect(columnCategory(col('x'), 0, 3)).toBe('todo');
  });
});
