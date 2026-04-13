import type { Pipeline } from '@/shared/types';

/**
 * Default pipeline used when a project has a linked repo.
 *
 * 6 columns: Backlog → Spec → Implementation → Review → PR → Completed
 * The supervisor agent uses these as milestones and moves tickets through them.
 */
export const DEFAULT_PIPELINE: Pipeline = {
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'spec', label: 'Spec' },
    { id: 'implementation', label: 'Implementation' },
    { id: 'review', label: 'Review', gate: true },
    { id: 'pr', label: 'PR' },
    { id: 'completed', label: 'Completed' },
  ],
};

/**
 * Simplified pipeline for projects without a linked repo.
 * 3 columns: Backlog → Active → Done
 */
export const SIMPLE_PIPELINE: Pipeline = {
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'active', label: 'Active' },
    { id: 'done', label: 'Done' },
  ],
};
