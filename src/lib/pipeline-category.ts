/**
 * Status-category helpers for pipeline columns.
 *
 * The column graph is the agent's custom state machine (enforced via MCP
 * tools); the category is the human-facing universal state — global views
 * group by category and never key on raw column ids. This module is the one
 * place category semantics live:
 *
 *   - `categoryOf()` / `doneColumnIds()` for readers (replaces the old
 *     positional `columns[columns.length - 1]` terminal inference)
 *   - `normalizePipelineCategories()` + `validatePipelineCategories()` for
 *     the single write chokepoint (ProjectManager.updateProject) and the
 *     pipeline editor.
 */
import { ErrResult, OkResult, type Result } from '@/lib/result';
import type { Column, ColumnCategory, ColumnId, Pipeline } from '@/shared/types';

const CATEGORY_ORDER: Record<ColumnCategory, number> = { todo: 0, doing: 1, done: 2 };

export const CATEGORY_LABELS: Record<ColumnCategory, string> = {
  todo: 'To do',
  doing: 'Doing',
  done: 'Done',
};

/**
 * Positional fallback for columns without a declared category: last → done,
 * first → todo, middle → doing. A single-column pipeline lands on 'done'
 * (last wins), preserving the historical "last column = shipped" semantics.
 * Mirrors the SQLite/PG v15 backfill and `positionalCategory` in
 * omni-projects-db.
 */
export function positionalCategory(index: number, total: number): ColumnCategory {
  return index === total - 1 ? 'done' : index === 0 ? 'todo' : 'doing';
}

/** Resolve a column's category, falling back positionally for legacy data. */
export function columnCategory(column: Column, index: number, total: number): ColumnCategory {
  return column.category ?? positionalCategory(index, total);
}

/**
 * Category of the column a ticket sits in. Unknown column ids (ticket points
 * at a column that no longer exists) degrade to 'doing' — visible, not lost.
 */
export function categoryOf(pipeline: Pipeline | null | undefined, columnId: ColumnId): ColumnCategory {
  const columns = pipeline?.columns ?? [];
  const index = columns.findIndex((c) => c.id === columnId);
  if (index === -1) {
    return 'doing';
  }
  return columnCategory(columns[index]!, index, columns.length);
}

/** Ids of every 'done'-category column in a pipeline. */
export function doneColumnIds(pipeline: Pipeline | null | undefined): Set<ColumnId> {
  const columns = pipeline?.columns ?? [];
  const ids = new Set<ColumnId>();
  columns.forEach((col, i) => {
    if (columnCategory(col, i, columns.length) === 'done') {
      ids.add(col.id);
    }
  });
  return ids;
}

/** True when the ticket's column counts as shipped. */
export function isDoneColumn(pipeline: Pipeline | null | undefined, columnId: ColumnId): boolean {
  return categoryOf(pipeline, columnId) === 'done';
}

/**
 * Fill in missing categories positionally. Applied at the pipeline write
 * chokepoint so every persisted column carries an explicit category.
 */
export function normalizePipelineCategories(columns: Column[]): Column[] {
  return columns.map((col, i) => (col.category ? col : { ...col, category: positionalCategory(i, columns.length) }));
}

/**
 * Validate the category shape of a pipeline about to be saved:
 *   - at least one 'todo' column
 *   - exactly one 'done' column, and it must be last
 *   - categories non-decreasing along the column order (todo* doing* done)
 *
 * Enforced only on new saves — legacy rows were backfilled and are never
 * rejected on read.
 */
export function validatePipelineCategories(columns: Column[]): Result<void, string> {
  const total = columns.length;
  const cats = columns.map((col, i) => columnCategory(col, i, total));

  if (!cats.includes('todo')) {
    return ErrResult('Pipeline needs at least one "To do" column — new tickets have to land somewhere.');
  }
  const doneCount = cats.filter((c) => c === 'done').length;
  if (doneCount === 0) {
    return ErrResult('Pipeline needs a "Done" column at the end.');
  }
  if (doneCount > 1) {
    return ErrResult('Pipeline can only have one "Done" column.');
  }
  if (cats[total - 1] !== 'done') {
    return ErrResult('The "Done" column must be the last column.');
  }
  for (let i = 1; i < total; i++) {
    if (CATEGORY_ORDER[cats[i]!] < CATEGORY_ORDER[cats[i - 1]!]) {
      return ErrResult(
        `Categories must not move backwards: "${columns[i]!.label}" (${CATEGORY_LABELS[cats[i]!]}) comes after "${columns[i - 1]!.label}" (${CATEGORY_LABELS[cats[i - 1]!]}).`
      );
    }
  }
  return OkResult(undefined);
}
