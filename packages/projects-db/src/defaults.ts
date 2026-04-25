/**
 * Default pipeline columns for new projects.
 * Matches the launcher's DEFAULT_PIPELINE.
 */
export const DEFAULT_COLUMNS = [
  { label: 'Backlog', description: null, gate: false },
  { label: 'Spec', description: null, gate: false },
  { label: 'Implementation', description: null, gate: false },
  { label: 'Review', description: null, gate: true },
  { label: 'PR', description: null, gate: false },
  { label: 'Completed', description: null, gate: false },
];

export const SIMPLE_COLUMNS = [
  { label: 'Backlog', description: null, gate: false },
  { label: 'Active', description: null, gate: false },
  { label: 'Done', description: null, gate: false },
];
