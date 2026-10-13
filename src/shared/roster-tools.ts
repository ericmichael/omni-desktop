import type { ClientToolDef } from '@/lib/resident-agent';

/**
 * Roster tools — hiring and reshaping bots — declared only for workspace
 * superusers (Omni). Fulfilled by the manager, never the renderer.
 *
 * The approval is structural: a bot a bot creates starts *paused*, and only
 * the user can enable it from the roster. No run, no wakeup, no morning beat
 * until then. Neither tool can grant `superuser`, touch Omni, or edit the
 * calling bot itself.
 */
export const ROSTER_TOOLS: readonly ClientToolDef[] = [
  {
    name: 'create_bot',
    description:
      'Hire a new bot for the workspace. It is created PAUSED: tell the user what you made and why; they enable it from the roster. Give it a short role and a persona written as instructions to the bot (who it is, what it does, how it works with the others).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name, e.g. "Mara".' },
        role: { type: 'string', description: 'A few words, e.g. "QA engineer".' },
        personaText: { type: 'string', description: 'Instructions to the bot, in the second person.' },
        protocol: {
          type: 'string',
          description:
            'Its first protocol, markdown: what it is for, how it splits work, how it briefs workers and swarms, what it verifies before reporting done, what to avoid. Short; the bot revises it.',
        },
        projectIds: { type: 'array', items: { type: 'string' }, description: 'Projects to scope it to.' },
        morningHour: {
          type: 'integer',
          minimum: 0,
          maximum: 23,
          description: 'Local hour of a daily morning beat. Omit for none (the default).',
        },
      },
      required: ['name', 'role', 'personaText'],
    },
  },
  {
    name: 'update_bot',
    description:
      "Change another bot's name, role, persona, project scope or morning beat. Cannot change Omni, yourself, or whether a bot is enabled — the user does that from the roster.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string' },
        personaText: { type: 'string' },
        projectIds: { type: 'array', items: { type: 'string' } },
        morningHour: { type: ['integer', 'null'], minimum: 0, maximum: 23 },
      },
      required: ['id'],
    },
  },
];

export const ROSTER_TOOL_NAMES: readonly string[] = ROSTER_TOOLS.map((t) => t.name);
