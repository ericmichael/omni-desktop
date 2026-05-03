import { DEFAULT_COLUMNS, SIMPLE_COLUMNS } from 'omni-projects-db/defaults';

import type { Pipeline } from '@/shared/types';

const toPipeline = (cols: typeof DEFAULT_COLUMNS): Pipeline => ({
  columns: cols.map((c) => ({
    id: c.logicalId,
    label: c.label,
    ...(c.gate ? { gate: true } : {}),
  })),
});

/**
 * Default pipeline for projects with a linked repo.
 *
 * This is the **logical-id** view used as fallback / seed material — at
 * runtime the launcher reads pipeline columns from SQLite, where IDs are
 * prefixed with the project ID for global uniqueness.
 */
export const DEFAULT_PIPELINE: Pipeline = toPipeline(DEFAULT_COLUMNS);

/**
 * Simplified pipeline for projects without a linked repo.
 */
export const SIMPLE_PIPELINE: Pipeline = toPipeline(SIMPLE_COLUMNS);
