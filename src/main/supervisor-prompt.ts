import type { Column, Pipeline, Project, Ticket } from '@/shared/types';
import { isRepoSource } from '@/shared/types';

export type SupervisorContext = {
  /** First ~500 chars of the project's root page content. */
  projectBrief?: string;
  /** Recent ticket comments (most recent first, max 5). */
  recentComments?: { author: string; content: string }[];
  /** Titles of blocking tickets that are not yet completed. */
  blockerTitles?: string[];
  /**
   * Where the agent should write persistent output — resolved per profile by
   * the host (host dir / container `/workspace/.omni-artifacts/<id>`). Autopilot agents have no
   * code-tab to inject this via session variables, so it's surfaced in the
   * prompt; it must match where the launcher's ArtifactStore reads.
   */
  artifactsDir?: string;
};

/**
 * Output guidance, branched by what the project's workspace *is*. Plain
 * folders: everything the user asked for lands in the folder itself (it's the
 * user's own folder; the launcher mirrors it back). Repos: non-commit-worthy
 * work products go to the ticket's artifacts dir (the Artifacts panel)
 * instead of polluting the diff. No file-based PR writeup — a real PR's title
 * and body are composed at `gh pr create` time.
 */
const buildOutputSection = (project: Project, ctx?: SupervisorContext): string => {
  const repoSources = project.sources.filter(isRepoSource);
  const plainSources = project.sources.filter((s) => !isRepoSource(s));
  const parts: string[] = [];

  if (plainSources.length > 0) {
    const folders = plainSources.map((s) => `\`/workspace/${s.mountName}/\``).join(', ');
    parts.push(
      `Save anything this ticket asks you to produce (documents, decks, spreadsheets, images, …) directly in the project folder — ${folders} — next to the user's files. Files you put there reach the user's computer; do not invent side directories for deliverables.`
    );
  }
  if (repoSources.length > 0 && ctx?.artifactsDir) {
    parts.push(
      `The repo is a curated tree: only commit-worthy changes go in it. Work products that don't belong in version control — progress notes, research, generated reports — go to \`${ctx.artifactsDir}\`; files there persist across runs and appear in this ticket's **Artifacts** panel in the launcher.`
    );
  }
  if (parts.length === 0) {
    return '';
  }
  return `\n\n## Output for the user\n${parts.join('\n')}`;
};

/** Render optional context sections (project brief, comments, blockers, output). */
const buildContextSection = (project: Project, ctx?: SupervisorContext): string => {
  const parts: string[] = [];

  if (ctx?.projectBrief) {
    parts.push(`\n\n## Project Brief (preview)\n${ctx.projectBrief}`);
  }

  if (ctx?.blockerTitles && ctx.blockerTitles.length > 0) {
    parts.push(
      `\n\n## Blockers\nThis ticket is blocked by:\n${ctx.blockerTitles.map((t) => `- ${t}`).join('\n')}\nCheck whether these are resolved before starting work. If still blocked, escalate.`
    );
  }

  if (ctx?.recentComments && ctx.recentComments.length > 0) {
    const formatted = ctx.recentComments.map((c) => `[${c.author}]: ${c.content}`).join('\n\n');
    parts.push(`\n\n## Recent Comments\n${formatted}`);
  }

  parts.push(buildOutputSection(project, ctx));

  return parts.join('');
};

const listSection = (title: string, values?: string[]): string => {
  if (!values || values.length === 0) {
    return '';
  }
  return `\n${title}:\n${values.map((value) => `- ${value}`).join('\n')}`;
};

const workflowSection = (column?: Column): string => {
  const workflow = column?.workflow;
  if (!column || !workflow) {
    return '';
  }

  const parts: string[] = ['\n## Column Contract'];
  if (workflow.purpose) {
    parts.push(`Purpose: ${workflow.purpose}`);
  }
  const entryCriteria = listSection('Entry criteria', workflow.entryCriteria);
  if (entryCriteria) {
    parts.push(entryCriteria);
  }
  const definitionOfDone = listSection('Definition of done', workflow.definitionOfDone);
  if (definitionOfDone) {
    parts.push(definitionOfDone);
  }
  if (workflow.agentInstructions) {
    parts.push(`Column instructions:\n${workflow.agentInstructions}`);
  }
  const recommendedSkills = listSection('Recommended skills', workflow.recommendedSkills);
  if (recommendedSkills) {
    parts.push(recommendedSkills);
  }
  const allowedTransitions = listSection('Allowed transitions', workflow.allowedTransitions);
  if (allowedTransitions) {
    parts.push(allowedTransitions);
  }
  if (workflow.autoDispatch !== undefined) {
    parts.push(`Auto-dispatch: ${workflow.autoDispatch ? 'enabled' : 'disabled'}`);
  }
  return parts.join('\n');
};

const nextTransitionText = (ticket: Ticket, pipeline: Pipeline): string => {
  const currentIndex = pipeline.columns.findIndex((column) => column.id === ticket.columnId);
  const currentColumn = currentIndex >= 0 ? pipeline.columns[currentIndex] : undefined;
  const allowedTransitionIds = currentColumn?.workflow?.allowedTransitions;
  const nextColumn = allowedTransitionIds?.length
    ? pipeline.columns.find((column) => column.id === allowedTransitionIds[0])
    : pipeline.columns[currentIndex + 1];
  if (!nextColumn) {
    return 'No next column is available; if the current definition of done is satisfied, call `goal_complete` and stop.';
  }
  const gateText = nextColumn.gate ? ' This destination is a human gate; move there and stop without advancing further.' : '';
  return `When the current column definition of done is satisfied, move the ticket to \`${nextColumn.label}\` with \`move_ticket\`.${gateText}`;
};

/**
 * Build the system prompt for a supervisor agent session.
 * Single prompt replaces all per-column prompt templates.
 */
export const buildAutopilotGoalText = (
  ticket: Ticket,
  project: Project,
  pipeline: Pipeline,
  context?: SupervisorContext
): string => {
  const currentColumn = pipeline.columns.find((c) => c.id === ticket.columnId);
  const columnLabel = currentColumn?.label ?? ticket.columnId;
  const columnNames = pipeline.columns.map((c) => c.label).join(' → ');

  const descriptionBlock = ticket.description
    ? `Description: ${ticket.description}`
    : `No additional description was provided. The title is your complete task specification — infer scope and acceptance criteria from it and the codebase.`;

  return `You are a supervisor agent. Your job is to complete the ticket below. Do not refuse, do not ask for clarification, do not wait for more context. Start working immediately.

## Ticket
Title: ${ticket.title}
${descriptionBlock}
Priority: ${ticket.priority}
Current Column: ${columnLabel}

## Critical Rules

- **The ticket title and description are your complete instructions.** If the description is missing, the title alone defines your task. Use the codebase to fill in any gaps.
- **Never refuse to start work.** Explore the repo, understand the codebase, form a plan, and execute.
- **Never escalate just because the description is short.** Escalation is only for when you are truly blocked by something outside your control (missing credentials, ambiguous requirements with multiple conflicting interpretations, etc.).
- **You are working in an isolated sandbox.** It is safe to make changes freely. Do not ask for permission.

## Pipeline
${columnNames}

${nextTransitionText(ticket, pipeline)}
Do not edit YAML files or configuration files to manage ticket state — use your project management tools instead.${workflowSection(currentColumn)}

## How to Work

1. **Explore** — Read the codebase to understand the project structure and conventions.
2. **Plan** — Create a concrete plan with testable steps.
3. **Execute** — Use \`spawn_worker\` to delegate implementation tasks. Give each worker a clear goal, scope, context, boundaries, and acceptance criteria.
4. **Verify** — Run tests, check linting, review changes.
5. **Advance** — When work for the current column is complete, use \`move_ticket\` to advance the ticket.${buildContextSection(project, context)}`;
};

export const buildAutopilotAdditionalInstructions = (
  _ticket: Ticket,
  project: Project,
  _pipeline: Pipeline,
  context?: SupervisorContext
): string => {
  const artifactText = buildOutputSection(project, context);

  return `You are working on an Omni project ticket.

## Stable Rules

- Use project tools such as \`move_ticket\` to mutate ticket state; never edit DB, YAML, or config files to manage ticket state.
- Read ticket comments before starting and write a summary comment before ending.
- Respect gates; never move past a \`gate: true\` column automatically.
- Follow AGENTS.md for every source file you touch.
- Use \`spawn_worker\` only for independent subtasks with clear file ownership and acceptance criteria.
- Activate recommended skills when relevant, and follow activated skill requirements.
- Use \`goal_complete\` to end the autopilot loop when achieved or truly blocked.${artifactText}`;
};

export const buildSupervisorPrompt = buildAutopilotGoalText;
