import type { FleetPipeline } from '@/shared/types';

/**
 * Default pipeline used when a project has no custom pipeline configured.
 *
 * 6 columns: Backlog → Spec → Implementation → Review → PR → Completed
 * The supervisor agent uses these as milestones and moves tickets through them.
 */
export const DEFAULT_PIPELINE: FleetPipeline = {
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'spec', label: 'Spec' },
    { id: 'implementation', label: 'Implementation' },
    { id: 'review', label: 'Review', gate: true },
    { id: 'pr', label: 'PR' },
    { id: 'completed', label: 'Completed' },
  ],
};
