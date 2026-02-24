import { buildSentinelBlock } from '@/shared/fleet-defaults';
import type { FleetChecklistItem, FleetColumn, FleetPhase, FleetSentinel, FleetTicket } from '@/shared/types';

// #region Types

type PromptContext = {
  ticket: Pick<FleetTicket, 'title' | 'description'>;
  column: Pick<FleetColumn, 'label' | 'validSentinels'>;
  checklist: FleetChecklistItem[];
  phaseHistory: FleetPhase[];
  iteration: number;
};

// #endregion

// #region Checklist formatting

/**
 * Render a checklist as markdown checkboxes.
 * Returns `(no checklist items)` when the list is empty.
 */
export const formatChecklist = (items: FleetChecklistItem[]): string => {
  if (items.length === 0) {
    return '(no checklist items)';
  }
  return items.map((item) => `- [${item.completed ? 'x' : ' '}] ${item.text}`).join('\n');
};

// #endregion

// #region Phase history formatting

/**
 * Render previous phases as summary lines for the {{phase.history}} variable.
 */
export const formatPhaseHistory = (phases: FleetPhase[]): string => {
  if (phases.length === 0) {
    return '(no previous phases)';
  }
  return phases
    .map((p) => {
      const status = p.exitSentinel ? `${p.status} (${p.exitSentinel})` : p.status;
      const note = p.reviewNote ? ` — "${p.reviewNote}"` : '';
      return `- [${p.columnId}] attempt ${p.attempt}: ${status}${note}`;
    })
    .join('\n');
};

// #endregion

// #region Prompt interpolation

/**
 * Replace `{{variable}}` placeholders in a column's `promptTemplate`.
 */
export const interpolatePromptTemplate = (template: string, ctx: PromptContext): string => {
  const sentinelInstructions = buildSentinelBlock(ctx.column.validSentinels);

  const vars: Record<string, string> = {
    'ticket.title': ctx.ticket.title,
    'ticket.description': ctx.ticket.description,
    checklist: formatChecklist(ctx.checklist),
    'phase.history': formatPhaseHistory(ctx.phaseHistory),
    iteration: String(ctx.iteration),
    'column.label': ctx.column.label,
    sentinelInstructions,
  };

  return template.replace(/\{\{(\w[\w.]*)\}\}/g, (match, key: string) => {
    return key in vars ? vars[key]! : match;
  });
};

// #endregion

// #region Nudge prompt

/**
 * Build a column-scoped nudge prompt listing only that column's valid sentinels.
 */
export const buildNudgePrompt = (sentinels: FleetSentinel[]): string => {
  if (sentinels.length === 0) {
    return 'Continue working on the task.';
  }

  const lines = sentinels.map((s) => `- \`STATUS: ${s}\``);

  return `Continue working on the task. Pick up where you left off and make more progress.
When you are fully done, end your response with exactly one of these on its own line:
${lines.join('\n')}
Do not output a signal if there is still more work to do.`;
};

// #endregion
