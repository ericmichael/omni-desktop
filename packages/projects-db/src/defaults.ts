/**
 * Default pipeline columns for new projects — single source of truth.
 *
 * The actual SQLite `pipeline_columns.id` is computed by `defaultColumnId`
 * as `${projectId}__${logicalId}` so it is globally unique while staying
 * deterministic and reproducible across database syncs.
 */
export type ColumnWorkflowContract = {
  purpose?: string;
  entryCriteria?: string[];
  definitionOfDone?: string[];
  agentInstructions?: string;
  recommendedSkills?: string[];
  allowedTransitions?: string[];
  autoDispatch?: boolean;
};

export type ColumnDef = {
  logicalId: string;
  label: string;
  description?: string;
  gate?: boolean;
  maxConcurrent?: number;
  workflow?: ColumnWorkflowContract;
};

export const DEFAULT_COLUMNS: ColumnDef[] = [
  {
    logicalId: 'backlog',
    label: 'Backlog',
    description: 'Capture unscheduled or unstarted software work.',
    workflow: {
      purpose: 'Capture unscheduled or unstarted software work.',
      definitionOfDone: [
        'Ticket is ready to start or intentionally parked.',
        'Ticket has enough title and description for a human to understand the request.',
      ],
      agentInstructions: 'Do not edit source code in this column. If auto-dispatch starts here, move to the first active non-terminal column before working.',
      recommendedSkills: [],
    },
  },
  {
    logicalId: 'spec',
    label: 'Spec',
    description: 'Understand the request and produce a decision-complete implementation plan.',
    workflow: {
      purpose: 'Understand the request and produce a decision-complete implementation plan.',
      entryCriteria: [
        'Ticket has a title and project assignment.',
        'Any blocker tickets have been checked.',
      ],
      definitionOfDone: [
        'Ticket, project pages, milestone brief, and relevant comments have been read.',
        'Relevant source files and existing patterns have been inspected.',
        'A plan page exists with scope, implementation approach, test strategy, risks, and out-of-scope items.',
        'No source edits were made unless explicitly required to investigate a failing reproduction.',
      ],
      agentInstructions: 'Activate software-planning for feature, refactor, or spec work. Activate debug if this is a failure investigation and the root cause is not localized. Do not move to Implementation until the plan is decision-complete.',
      recommendedSkills: ['software-planning', 'debug'],
    },
  },
  {
    logicalId: 'implementation',
    label: 'Implementation',
    description: 'Make the planned source changes.',
    workflow: {
      purpose: 'Make the planned source changes.',
      entryCriteria: [
        'The ticket has a decision-complete plan, or the ticket is small enough that the title and description fully define the change.',
        'Required source context has been read.',
      ],
      definitionOfDone: [
        'Planned code changes are implemented with minimal unrelated churn.',
        'Tests are added or updated where the codebase has an appropriate testing pattern.',
        'Targeted tests pass.',
        'PR title/body artifacts are current.',
        'No debug prints, stale TODOs, or commented-out code remain.',
      ],
      agentInstructions: 'Follow AGENTS.md in every source touched. Use worker agents only for independent subtasks with explicit file ownership and acceptance criteria. For bug fixes, prefer red-before-green testing when practical.',
      recommendedSkills: ['debug', 'software-planning'],
    },
  },
  {
    logicalId: 'review',
    label: 'Review',
    description: 'Human review gate.',
    gate: true,
    workflow: {
      purpose: 'Human review gate.',
      definitionOfDone: [
        'Human has reviewed the changes, artifacts, and test evidence.',
        'Human decides whether to advance, request changes, or stop.',
      ],
      agentInstructions: 'This is a gate. Move tickets into this column when ready for human review, then stop. Never advance past this column automatically. Add a ticket comment summarizing completed work, test evidence, known risks, and next recommended action.',
      recommendedSkills: [],
    },
  },
  {
    logicalId: 'pr',
    label: 'PR',
    description: 'Prepare, update, and shepherd pull request state after human review approval.',
    workflow: {
      purpose: 'Prepare, update, and shepherd pull request state after human review approval.',
      entryCriteria: [
        'Ticket has passed the Review gate by human action.',
        'Source changes are ready to publish or already published.',
      ],
      definitionOfDone: [
        'PR title/body are accurate.',
        'Branch/PR metadata is linked to the ticket where available.',
        'CI or local validation status is recorded.',
        'Merge readiness is clear, or blockers are documented.',
      ],
      agentInstructions: 'Use push/PR-related skills only when explicitly asked or when the project workflow expects PR preparation. Do not merge unless the user or project policy explicitly allows it.',
      recommendedSkills: ['push', 'pull', 'land'],
    },
  },
  {
    logicalId: 'completed',
    label: 'Completed',
    description: 'Terminal resolved state.',
    workflow: {
      purpose: 'Terminal resolved state.',
      definitionOfDone: [
        'Work is complete and accepted.',
        'Cleanup has run or been explicitly deferred because worktree changes remain.',
      ],
      agentInstructions: 'Do not start autopilot in this column. Entering this column stops supervision and cleans up workspace state when safe.',
      recommendedSkills: [],
    },
  },
];

export const SIMPLE_COLUMNS: ColumnDef[] = [
  {
    logicalId: 'backlog',
    label: 'Backlog',
    description: 'Capture unstarted ideas, notes, or tasks.',
    workflow: {
      purpose: 'Capture unstarted ideas, notes, or tasks.',
      definitionOfDone: ['Item is clear enough to review or act on.'],
      recommendedSkills: [],
    },
  },
  {
    logicalId: 'review',
    label: 'Review',
    description: 'Human review, shaping, or approval.',
    gate: true,
    workflow: {
      purpose: 'Human review, shaping, or approval.',
      definitionOfDone: ['Human has decided whether the item is complete, needs more detail, or should become source-backed work.'],
      recommendedSkills: [],
    },
  },
  {
    logicalId: 'completed',
    label: 'Completed',
    description: 'Terminal state for finished work.',
    workflow: {
      purpose: 'Terminal state for finished work.',
      definitionOfDone: ['Outcome is accepted or no further action is needed.'],
      recommendedSkills: [],
    },
  },
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
