import type { FleetPipeline, FleetSentinel } from '@/shared/types';

/**
 * Build the sentinel instructions block for a column's prompt template.
 * Auto-generated from the column's `validSentinels` array.
 */
export const buildSentinelBlock = (sentinels: FleetSentinel[]): string => {
  if (sentinels.length === 0) {
    return '';
  }

  const descriptions: Record<FleetSentinel, string> = {
    CHECKLIST_COMPLETE: 'all exit criteria for this column are met',
    BLOCKED: 'you need human intervention (missing credentials, unclear requirements, external dependency)',
    TESTS_FAILING: 'quality checks are failing and you cannot fix them',
    NEEDS_REVIEW: 'requesting human review before proceeding',
    REJECTED: 'the work does not meet the checklist criteria',
  };

  const lines = sentinels.map((s) => `- \`STATUS: ${s}\` — ${descriptions[s]}`);

  return `## Completion Signals
Your FINAL message MUST end with exactly one of these on its own line:
${lines.join('\n')}
If the work is not yet done and you are not blocked, do NOT output any sentinel — just end your message normally and another iteration will continue.`;
};

/**
 * Default pipeline used when a project has no custom pipeline configured.
 *
 * 6 columns: Backlog → Spec → Implementation → Review → PR → Completed
 */
export const DEFAULT_PIPELINE: FleetPipeline = {
  columns: [
    // --- Backlog: passive, no agent ---
    {
      id: 'backlog',
      label: 'Backlog',
      role: 'none',
      promptTemplate: '',
      validSentinels: [],
      requiresApproval: false,
      autoStart: false,
      maxIterations: 0,
      defaultChecklist: [],
    },

    // --- Spec: optional agent, human gate ---
    {
      id: 'spec',
      label: 'Spec',
      role: 'specifier',
      promptTemplate: `You are a specification agent. Your job is to break down this ticket into a clear, testable checklist of acceptance criteria.

## Ticket
Title: {{ticket.title}}
Description: {{ticket.description}}

## Current Checklist
{{checklist}}

## Instructions
- Analyze the ticket and produce a detailed checklist of things that need to be done.
- Each item should be independently verifiable and actionable.
- Do NOT implement anything. Only produce the spec.
- Output the final checklist as a JSON array in a fenced code block:
\`\`\`json
[{"text": "criterion description", "completed": false}]
\`\`\`

{{sentinelInstructions}}`,
      validSentinels: ['CHECKLIST_COMPLETE', 'BLOCKED'],
      requiresApproval: true,
      autoStart: false,
      maxIterations: 3,
      defaultChecklist: [],
    },

    // --- Implementation: auto-start, autonomous ---
    {
      id: 'implementation',
      label: 'Implementation',
      role: 'implementer',
      promptTemplate: `You are an implementation agent. Your ONLY job is to write code that satisfies the checklist.

## Ticket
Title: {{ticket.title}}
Description: {{ticket.description}}

## Plan File
Your plan and checklist are at: {{planFilePath}}
Read this file for your current checklist. When you complete an item, edit the file to mark it as done (change \`- [ ]\` to \`- [x]\`).

## Checklist (your exit criteria)
{{checklist}}

## Instructions
- Implement each unchecked checklist item.
- Do NOT add features beyond the checklist. Do NOT refactor unrelated code.
- Run quality checks (typecheck, lint, tests) before finishing.
- If progress.txt exists, read it for context from previous iterations.
- Append a brief summary of what you accomplished to progress.txt before finishing.
- Make incremental progress. It's fine to not finish everything — another iteration will continue.
- Update the plan file as you complete checklist items.

{{sentinelInstructions}}`,
      validSentinels: ['CHECKLIST_COMPLETE', 'BLOCKED', 'TESTS_FAILING'],
      requiresApproval: false,
      autoStart: true,
      maxIterations: 10,
      defaultChecklist: [],
    },

    // --- Review: auto-start, verifies implementation ---
    {
      id: 'review',
      label: 'Review',
      role: 'reviewer',
      promptTemplate: `You are a code review agent. Your job is to verify the implementation against the checklist.

## Ticket
Title: {{ticket.title}}
Description: {{ticket.description}}

## Plan File
The plan and checklist are at: {{planFilePath}}
Read this file for the full checklist. Mark review items as done when verified (change \`- [ ]\` to \`- [x]\`).

## Checklist
{{checklist}}

## Phase History
{{phase.history}}

## Instructions
- Review the code changes (git diff) against each checklist item.
- Run tests and quality checks.
- Do NOT add new features or make implementation changes beyond minor fixes.
- If all checklist items pass verification, signal CHECKLIST_COMPLETE.
- If items fail verification, signal REJECTED with a clear explanation of what needs fixing.
- Update the plan file as you verify checklist items.

{{sentinelInstructions}}`,
      validSentinels: ['CHECKLIST_COMPLETE', 'REJECTED', 'BLOCKED'],
      requiresApproval: false,
      autoStart: true,
      maxIterations: 3,
      defaultChecklist: [
        { id: 'review-default-1', text: 'All tests pass', completed: false },
        { id: 'review-default-2', text: 'No lint errors', completed: false },
        { id: 'review-default-3', text: 'Matches spec', completed: false },
      ],
    },

    // --- PR: auto-start, assembles PR, human gate ---
    {
      id: 'pr',
      label: 'PR',
      role: 'assembler',
      promptTemplate: `You are a PR assembly agent. Your job is to create or update a pull request that cleanly presents the work done.

## Ticket
Title: {{ticket.title}}
Description: {{ticket.description}}

## Plan File
The plan and checklist are at: {{planFilePath}}

## Checklist
{{checklist}}

## Phase History
{{phase.history}}

## Instructions
- Review the git log and diff to understand all changes made.
- Create a well-structured PR description with:
  - A clear summary of what was done and why.
  - The checklist items addressed.
  - Any notable implementation decisions.
  - Testing notes.
- Use the appropriate git/gh CLI commands to create or update the PR.
- Do NOT make code changes. Only assemble the PR.

{{sentinelInstructions}}`,
      validSentinels: ['CHECKLIST_COMPLETE', 'BLOCKED'],
      requiresApproval: true,
      autoStart: true,
      maxIterations: 3,
      defaultChecklist: [
        { id: 'pr-default-1', text: 'PR description complete', completed: false },
        { id: 'pr-default-2', text: 'CI passing', completed: false },
      ],
    },

    // --- Completed: terminal passive column ---
    {
      id: 'completed',
      label: 'Completed',
      role: 'none',
      promptTemplate: '',
      validSentinels: [],
      requiresApproval: false,
      autoStart: false,
      maxIterations: 0,
      defaultChecklist: [],
    },
  ],
};
