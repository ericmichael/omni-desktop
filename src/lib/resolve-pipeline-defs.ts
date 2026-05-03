/**
 * Pure resolver for the column defs to write into `pipeline_columns`.
 *
 * Decision policy:
 *   1. FLEET.md declares a pipeline → that's authoritative.
 *   2. Otherwise, if SQLite already has columns for the project → return
 *      `null` (leave existing rows alone). This protects user pipeline edits
 *      from being clobbered when no FLEET.md is present.
 *   3. Otherwise (no FLEET.md, no existing rows) → seed defaults appropriate
 *      to the project source kind.
 *
 * Extracted into `@/lib` so the policy can be unit-tested without a full
 * ProjectManager / SQLite stack. Wiring lives in
 * `ProjectManager.syncPipelineForProject`.
 */
import type { ColumnSyncInput } from 'omni-projects-db';
import { DEFAULT_COLUMNS, SIMPLE_COLUMNS } from 'omni-projects-db';

import type { WorkflowConfig } from '@/lib/workflow';

export interface ResolvePipelineDefsInput {
  /** Whether the project has a linked source (local repo, git remote). */
  hasSource: boolean;
  /** Whether `pipeline_columns` already has rows for this project. */
  hasExisting: boolean;
  /** Parsed FLEET.md config — pass `null` / `{}` if absent. */
  workflow: WorkflowConfig | null | undefined;
}

export const resolvePipelineDefs = (
  input: ResolvePipelineDefsInput
): ColumnSyncInput[] | null => {
  const fleetCols = input.workflow?.pipeline?.columns;
  if (fleetCols && fleetCols.length > 0) {
    return fleetCols.map((c) => ({
      logicalId: c.id,
      label: c.label,
      gate: c.gate,
    }));
  }
  if (input.hasExisting) {
    return null;
  }
  const seed = input.hasSource ? DEFAULT_COLUMNS : SIMPLE_COLUMNS;
  return seed.map((c) => ({ logicalId: c.logicalId, label: c.label, gate: c.gate }));
};
