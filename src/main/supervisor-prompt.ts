import { getContainerArtifactsDir } from '@/lib/artifacts';
import type { Pipeline, Project, Ticket } from '@/shared/types';

export type SupervisorContext = {
  /** First ~500 chars of the project's root page content. */
  projectBrief?: string;
  /** Recent ticket comments (most recent first, max 5). */
  recentComments?: { author: string; content: string }[];
  /** Titles of blocking tickets that are not yet completed. */
  blockerTitles?: string[];
};

/** Render optional context sections (project brief, comments, blockers). */
const buildContextSection = (ctx?: SupervisorContext): string => {
  if (!ctx) {
return '';
}
  const parts: string[] = [];

  if (ctx.projectBrief) {
    parts.push(`\n\n## Project Brief (preview)\n${ctx.projectBrief}`);
  }

  if (ctx.blockerTitles && ctx.blockerTitles.length > 0) {
    parts.push(
      `\n\n## Blockers\nThis ticket is blocked by:\n${ctx.blockerTitles.map((t) => `- ${t}`).join('\n')}\nCheck whether these are resolved before starting work. If still blocked, escalate.`
    );
  }

  if (ctx.recentComments && ctx.recentComments.length > 0) {
    const formatted = ctx.recentComments
      .map((c) => `[${c.author}]: ${c.content}`)
      .join('\n\n');
    parts.push(`\n\n## Recent Comments\n${formatted}`);
  }

  return parts.join('');
};

/**
 * Build the system prompt for a supervisor agent session.
 * Single prompt replaces all per-column prompt templates.
 */
export const buildSupervisorPrompt = (
  ticket: Ticket,
  project: Project,
  pipeline: Pipeline,
  context?: SupervisorContext
): string => {
  const artifactsDir = getContainerArtifactsDir(ticket.id);
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

When your work for the current column is complete, use \`move_ticket\` to advance the ticket to the next column.
Do not edit YAML files or configuration files to manage ticket state — use your project management tools instead.

## Skills
Use the \`omni-projects-tickets\` skill for guidance on project management workflows, tool usage patterns, and domain concepts (pipelines, gates, milestones, pages, inbox). Consult its references when you need to understand how tools work together or what the correct workflow is.

## Artifacts Directory
Persistent artifacts directory: ${artifactsDir}
Use this for progress notes, research, scratch work, or any files that should persist.

## How to Work

1. **Explore** — Read the codebase to understand the project structure and conventions.
2. **Plan** — Create a concrete plan with testable steps.
3. **Execute** — Use \`spawn_worker\` to delegate implementation tasks. Give each worker a clear goal, scope, context, boundaries, and acceptance criteria.
4. **Verify** — Run tests, check linting, review changes.
5. **Advance** — When work for the current column is complete, use \`move_ticket\` to advance the ticket.${buildContextSection(context)}`;
};
