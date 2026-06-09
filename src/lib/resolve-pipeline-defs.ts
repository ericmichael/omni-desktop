/**
 * Pure resolver for the column defs to write into `pipeline_columns`.
 *
 * Decision policy:
 *   1. If SQLite already has columns for the project → return `null` (leave
 *      existing rows alone). The projects database is the live source of truth.
 *   2. Otherwise seed defaults appropriate to the project source kind.
 *
 * Extracted into `@/lib` so the policy can be unit-tested without a full
 * ProjectManager / SQLite stack. Wiring lives in
 * `ProjectManager.syncPipelineForProject`.
 */
import type { ColumnSyncInput } from 'omni-projects-db';
import { DEFAULT_COLUMNS, SIMPLE_COLUMNS } from 'omni-projects-db';

export interface ResolvePipelineDefsInput {
  /** Whether the project has a linked source (local repo, git remote). */
  hasSource: boolean;
  /** Whether `pipeline_columns` already has rows for this project. */
  hasExisting: boolean;
}

export const resolvePipelineDefs = (
  input: ResolvePipelineDefsInput
): ColumnSyncInput[] | null => {
  if (input.hasExisting) {
    return null;
  }
  const seed = input.hasSource ? DEFAULT_COLUMNS : SIMPLE_COLUMNS;
  return seed.map((c) => ({
    logicalId: c.logicalId,
    label: c.label,
    description: c.description,
    gate: c.gate,
    maxConcurrent: c.maxConcurrent,
    workflow: c.workflow,
  }));
};
