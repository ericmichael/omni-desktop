/**
 * Default pipeline columns for new projects — single source of truth.
 *
 * Each column has:
 * - `logicalId`: stable per-project string (`backlog`, `spec`, ...) used in
 *   prompts and database sync.
 * - `label`: human-readable display name.
 * - `gate`: whether this column requires human review.
 *
 * The actual SQLite `pipeline_columns.id` is computed by `defaultColumnId`
 * as `${projectId}__${logicalId}` so it is globally unique while staying
 * deterministic and reproducible across database syncs.
 */
export type ColumnDef = {
  logicalId: string;
  label: string;
  gate?: boolean;
};

export const DEFAULT_COLUMNS: ColumnDef[] = [
  { logicalId: 'backlog', label: 'Backlog' },
  { logicalId: 'spec', label: 'Spec' },
  { logicalId: 'implementation', label: 'Implementation' },
  { logicalId: 'review', label: 'Review', gate: true },
  { logicalId: 'pr', label: 'PR' },
  { logicalId: 'completed', label: 'Completed' },
];

export const SIMPLE_COLUMNS: ColumnDef[] = [
  { logicalId: 'backlog', label: 'Backlog' },
  { logicalId: 'review', label: 'Review', gate: true },
  { logicalId: 'completed', label: 'Completed' },
];

/**
 * Compute the SQLite primary-key for a column given its project and
 * logical id. Format: `${projectId}__${logicalId}`. Globally unique because
 * project IDs are themselves unique.
 */
export const defaultColumnId = (projectId: string, logicalId: string): string => `${projectId}__${logicalId}`;

/**
 * Inverse of `defaultColumnId` — extract the logical id portion. Returns
 * the input unchanged if it doesn't carry a project prefix (covers legacy
 * rows from earlier launcher versions).
 */
export const logicalColumnId = (projectId: string, columnId: string): string => {
  const prefix = `${projectId}__`;
  return columnId.startsWith(prefix) ? columnId.slice(prefix.length) : columnId;
};
