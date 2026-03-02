import type { FleetPipeline } from '@/shared/types';

/**
 * Default pipeline used when a project has no custom pipeline configured.
 *
 * 6 columns: Backlog → Spec → Implementation → Review → PR → Completed
 * The supervisor agent uses these as milestones and moves tickets through them.
 */
export const DEFAULT_PIPELINE: FleetPipeline = {
  columns: [
    {
      id: 'backlog',
      label: 'Backlog',
      defaultChecklist: [],
    },
    {
      id: 'spec',
      label: 'Spec',
      defaultChecklist: [],
    },
    {
      id: 'implementation',
      label: 'Implementation',
      defaultChecklist: [],
    },
    {
      id: 'review',
      label: 'Review',
      defaultChecklist: [
        { id: 'review-default-1', text: 'All tests pass', completed: false },
        { id: 'review-default-2', text: 'No lint errors', completed: false },
        { id: 'review-default-3', text: 'Matches spec', completed: false },
        { id: 'review-default-4', text: 'Acceptance evidence collected (if web app)', completed: false },
      ],
    },
    {
      id: 'pr',
      label: 'PR',
      defaultChecklist: [
        { id: 'pr-default-1', text: 'PR description complete', completed: false },
        { id: 'pr-default-2', text: 'CI passing', completed: false },
      ],
    },
    {
      id: 'completed',
      label: 'Completed',
      defaultChecklist: [],
    },
  ],
};
