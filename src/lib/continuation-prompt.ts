/**
 * Pure continuation-prompt builder for supervisor runs.
 *
 * Extracted from ProjectManager (Sprint C1 of the project-manager
 * decomposition). No side effects — caller passes the ticket, pipeline, and
 * optional FLEET.md custom template and this returns the prompt string.
 */
import type { Pipeline, Ticket } from '@/shared/types';

export interface ContinuationPromptInput {
  ticket: Ticket | undefined;
  pipeline: Pipeline | null;
  /** FLEET.md override — supports `{{turn}}` and `{{maxTurns}}` substitution. */
  customContinuation?: string;
  turn: number;
  maxTurns: number;
}

export function buildContinuationPrompt(input: ContinuationPromptInput): string {
  const { ticket, pipeline, customContinuation, turn, maxTurns } = input;

  if (customContinuation) {
    return customContinuation.replace(/\{\{turn}}/g, String(turn)).replace(/\{\{maxTurns}}/g, String(maxTurns));
  }

  const columnLabels = pipeline?.columns.map((c) => c.label).join(', ') ?? '';
  const currentColumn = pipeline?.columns.find((c) => c.id === ticket?.columnId)?.label ?? ticket?.columnId ?? '';

  const runs = ticket?.runs ?? [];
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
  const lastRunReason = lastRun?.endReason ? `- The previous run ended with reason: "${lastRun.endReason}".` : '';

  const comments = ticket?.comments ?? [];
  const lastComment = comments.length > 0 ? comments[comments.length - 1] : undefined;
  const lastCommentLine = lastComment
    ? `- Last comment [${lastComment.author}]: ${lastComment.content.length > 200 ? `${lastComment.content.slice(0, 200)}…` : lastComment.content}`
    : '';

  return [
    'Continuation guidance:',
    '',
    `- This is continuation turn ${turn} of ${maxTurns}.`,
    lastRunReason,
    lastCommentLine,
    `- Resume from current workspace state — do not restart from scratch or re-read files you already have in context.`,
    `- The original task instructions and prior context are already in this session, so do not restate them before acting.`,
    `- Use your best judgement to move the work forward. You are working in an isolated sandbox, so it is safe to make changes freely. Do not ask for confirmation or escalate to the user unless you are truly blocked on something that requires human input. The human will review your work at a later stage.`,
    `- Your ticket is currently in column "${currentColumn}". If you have completed the work, call \`move_ticket\` to advance it. Valid columns: ${columnLabels}.`,
    `- Before continuing, use \`add_ticket_comment\` to briefly record what you accomplished so far and what remains. This helps future runs (and humans) understand the state of work.`,
    `- Use \`notify\` to send the human a heads-up without stopping. Use \`escalate\` only when you truly cannot proceed without human input.`,
  ]
    .filter(Boolean)
    .join('\n');
}
