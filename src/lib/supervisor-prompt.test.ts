import { describe, expect, it } from 'vitest';

import {
  buildAutopilotAdditionalInstructions,
  buildAutopilotGoalText,
  buildSupervisorPrompt,
} from '@/main/supervisor-prompt';
import type { Column, Pipeline, Project, Ticket } from '@/shared/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makePipeline = (columns: Column[]): Pipeline => ({
  columns: columns.map((c) => ({
    ...c,
  })),
});

const makeTicket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'ticket-42',
  projectId: 'proj-1',
  milestoneId: 'ms-1',
  title: 'Add dark mode',
  description: 'Implement dark mode across the entire app.',
  priority: 'high',
  columnId: 'col-impl',
  blockedBy: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'proj-1',
  label: 'My Project',
  slug: 'my-project',
  sources: [{ id: 'src-1', mountName: 'project', kind: 'local', workspaceDir: '/home/user/project' }],
  createdAt: Date.now(),
  ...overrides,
});

const PIPELINE = makePipeline([
  { id: 'col-backlog', label: 'Backlog' },
  { id: 'col-spec', label: 'Spec' },
  { id: 'col-impl', label: 'Implementation' },
  { id: 'col-done', label: 'Done' },
]);

const WORKFLOW_PIPELINE = makePipeline([
  { id: 'col-backlog', label: 'Backlog' },
  {
    id: 'col-impl',
    label: 'Implementation',
    maxConcurrent: 2,
    workflow: {
      purpose: 'Turn the approved plan into a tested product change.',
      entryCriteria: ['Spec is approved by a human reviewer', 'Dependencies are unblocked'],
      definitionOfDone: ['Feature flag persists across restarts', 'Targeted Vitest coverage passes'],
      agentInstructions: 'Keep implementation minimal and preserve public APIs.',
      recommendedSkills: ['software-bugfix', 'typescript'],
      allowedTransitions: ['col-review'],
      autoDispatch: true,
    },
  },
  {
    id: 'col-review',
    label: 'Review',
    gate: true,
    workflow: {
      purpose: 'Human review gate.',
      definitionOfDone: ['Reviewer has inspected the full PR diff'],
    },
  },
  { id: 'col-done', label: 'Done' },
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSupervisorPrompt', () => {
  it('includes ticket title and description', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('Title: Add dark mode');
    expect(prompt).toContain('Implement dark mode across the entire app.');
  });

  it('includes priority', () => {
    const prompt = buildSupervisorPrompt(makeTicket({ priority: 'critical' }), makeProject(), PIPELINE);
    expect(prompt).toContain('Priority: critical');
  });

  it('includes current column label', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('Current Column: Implementation');
  });

  it('mentions key tool names', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('move_ticket');
  });

  // Artifacts guidance now lives in `buildContextIdentifiers`
  // (src/lib/client-tools.ts) so it covers both supervisor and non-supervisor
  // ticket sessions. The supervisor prompt intentionally no longer duplicates it.

  it('includes pipeline column names', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('Backlog → Spec → Implementation → Done');
  });

  it('handles missing description gracefully', () => {
    const prompt = buildSupervisorPrompt(makeTicket({ description: '' }), makeProject(), PIPELINE);
    expect(prompt).toContain('title is your complete task specification');
  });

  it('includes worker dispatch guidelines', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).toContain('spawn_worker');
    expect(prompt).toContain('boundaries');
  });

  it('includes project brief when provided in context', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE, {
      projectBrief: '# My Project\nBuilding a widget system.',
    });
    expect(prompt).toContain('## Project Brief (preview)');
    expect(prompt).toContain('Building a widget system');
  });

  it('includes blocker titles when provided in context', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE, {
      blockerTitles: ['Set up database', 'Configure auth'],
    });
    expect(prompt).toContain('## Blockers');
    expect(prompt).toContain('- Set up database');
    expect(prompt).toContain('- Configure auth');
  });

  it('includes recent comments when provided in context', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE, {
      recentComments: [
        { author: 'agent', content: 'Completed auth middleware' },
        { author: 'human', content: 'Looks good, continue with tests' },
      ],
    });
    expect(prompt).toContain('## Recent Comments');
    expect(prompt).toContain('[agent]: Completed auth middleware');
    expect(prompt).toContain('[human]: Looks good, continue with tests');
  });

  it('omits context sections when not provided', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).not.toContain('## Project Brief');
    expect(prompt).not.toContain('## Blockers');
    expect(prompt).not.toContain('## Recent Comments');
  });

  it('does not render the workspace layout — that lives in buildContextIdentifiers', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE);
    expect(prompt).not.toContain('## Workspace Layout');
  });

  it('plain-folder projects get deliverables-in-the-folder guidance, never an artifacts dir or PR writeup', () => {
    const prompt = buildSupervisorPrompt(makeTicket(), makeProject(), PIPELINE, {
      artifactsDir: '/workspace/.omni-artifacts/t1',
    });
    expect(prompt).toContain('## Output for the user');
    expect(prompt).toContain('`/workspace/project/`');
    expect(prompt).not.toContain('.omni-artifacts');
    expect(prompt).not.toContain('PR_TITLE');
  });

  it('repo projects surface the artifacts dir for non-commit-worthy output, without PR writeup paths', () => {
    const repoProject = makeProject({
      sources: [{ id: 'src-1', mountName: 'repo', kind: 'local', workspaceDir: '/home/user/repo', gitDetected: true }],
    });
    const prompt = buildSupervisorPrompt(makeTicket(), repoProject, PIPELINE, {
      artifactsDir: '/workspace/.omni-artifacts/t1',
    });
    expect(prompt).toContain('## Output for the user');
    expect(prompt).toContain('/workspace/.omni-artifacts/t1');
    expect(prompt).not.toContain('PR_TITLE');
    expect(prompt).not.toContain('PR_BODY');
  });

  it('omits the output section for repo projects when no artifactsDir is provided', () => {
    const repoProject = makeProject({
      sources: [{ id: 'src-1', mountName: 'repo', kind: 'git-remote', repoUrl: 'https://github.com/a/r' }],
    });
    expect(buildSupervisorPrompt(makeTicket(), repoProject, PIPELINE)).not.toContain('## Output for the user');
  });
});

describe('buildAutopilotGoalText', () => {
  it('includes ticket details and the current column workflow contract', () => {
    const goalText = buildAutopilotGoalText(makeTicket(), makeProject(), WORKFLOW_PIPELINE);

    expect(goalText).toContain('Title: Add dark mode');
    expect(goalText).toContain('Implement dark mode across the entire app.');
    expect(goalText).toContain('Priority: high');
    expect(goalText).toContain('Current Column: Implementation');
    expect(goalText).toContain('Turn the approved plan into a tested product change.');
    expect(goalText).toContain('Spec is approved by a human reviewer');
    expect(goalText).toContain('Feature flag persists across restarts');
    expect(goalText).toContain('Keep implementation minimal and preserve public APIs.');
    expect(goalText).toContain('software-bugfix');
    expect(goalText).toContain('col-review');
    expect(goalText).toMatch(/auto.?dispatch/i);
    expect(goalText).not.toContain('Reviewer has inspected the full PR diff');
  });

  it('preserves optional supervisor context in the goal text', () => {
    const goalText = buildAutopilotGoalText(makeTicket(), makeProject(), WORKFLOW_PIPELINE, {
      projectBrief: '# My Project\nBuilding a widget system.',
      blockerTitles: ['Set up database'],
      recentComments: [{ author: 'human', content: 'Please keep the API stable' }],
    });

    expect(goalText).toContain('Building a widget system');
    expect(goalText).toContain('Set up database');
    expect(goalText).toContain('[human]: Please keep the API stable');
  });
});

describe('buildAutopilotAdditionalInstructions', () => {
  it('contains durable tool, output, and gate rules', () => {
    const repoProject = makeProject({
      sources: [{ id: 'src-1', mountName: 'repo', kind: 'local', workspaceDir: '/home/user/repo', gitDetected: true }],
    });
    const additionalInstructions = buildAutopilotAdditionalInstructions(makeTicket(), repoProject, WORKFLOW_PIPELINE, {
      artifactsDir: '/workspace/.omni-artifacts/ticket-42',
    });

    expect(additionalInstructions).toContain('move_ticket');
    expect(additionalInstructions).toContain('spawn_worker');
    expect(additionalInstructions).toContain('/workspace/.omni-artifacts/ticket-42');
    expect(additionalInstructions).not.toContain('PR_TITLE');
    expect(additionalInstructions).not.toContain('PR_BODY');
    expect(additionalInstructions).toMatch(/gate/i);
  });

  it('does not duplicate ticket-specific goal details or the full current column DoD', () => {
    const additionalInstructions = buildAutopilotAdditionalInstructions(makeTicket(), makeProject(), WORKFLOW_PIPELINE);

    expect(additionalInstructions).not.toContain('Title: Add dark mode');
    expect(additionalInstructions).not.toContain('Implement dark mode across the entire app.');
    expect(additionalInstructions).not.toContain('Feature flag persists across restarts');
    expect(additionalInstructions).not.toContain('Targeted Vitest coverage passes');
  });
});
