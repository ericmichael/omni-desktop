import type { ClientToolDef } from '@/lib/resident-agent';
import type { ResidentProtocolRow } from 'omni-projects-db';

/**
 * A bot's protocol: how it operates, in its own words — how it splits work,
 * briefs workers and swarms, what it checks before calling something done,
 * what it has learned not to do. The persona says who the bot is; the
 * protocol says how it works, and the bot revises it as it works. Versioned,
 * so a bad revision is visible and can be rolled back.
 */
export const PROTOCOL_MAX_CHARS = 24_000;

export const PROTOCOL_TOOLS: readonly ClientToolDef[] = [
  {
    name: 'read_protocol',
    description: 'Read your current protocol — your own operating manual — with its version.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_protocol',
    description:
      'Replace your protocol with a revised whole. Do this when you learn something about how to work: a way of briefing workers that produced good results, a swarm shape that failed and why, a check you now do before reporting done. Keep it a manual, not a diary — procedures, not events. Give a one-line note saying what changed.',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The full protocol, markdown.' },
        note: { type: 'string', description: 'What changed and why, in a line.' },
      },
      required: ['body', 'note'],
    },
  },
];

export const PROTOCOL_TOOL_NAMES: readonly string[] = PROTOCOL_TOOLS.map((t) => t.name);

/** Skills ride the workspace: anything under `home/skills/<name>/SKILL.md` is
 *  discovered for the bot's own sessions and copied to the workers and
 *  swarms it dispatches, because workers inherit the parent's local sources. */
const SKILLS_LINE =
  'A procedure that has proven itself and that your workers or swarms should follow too belongs in a skill: ' +
  'write `home/skills/<name>/SKILL.md` (a short description, then the steps). Skills there load for you and ' +
  'for every worker you dispatch.\n';

/** The block in a bot's instructions. Placed first: it is the manual. */
export function protocolContext(protocol: ResidentProtocolRow | null): string {
  if (!protocol) {
    return (
      '## How you operate\n' +
      'You have no protocol yet. After your first real piece of work, write one with `update_protocol`: ' +
      'how you split work, how you brief workers and swarms, what you verify before reporting, what to avoid. ' +
      'Revise it as you learn.\n\n'
    );
  }
  return (
    `## How you operate (your protocol, v${protocol.version})\n` +
    'Yours to keep current with `update_protocol` — after a swarm that worked, a failure with a cause, ' +
    'a brief that produced good work. It binds you the way the handbook does.\n' +
    SKILLS_LINE +
    `\n${protocol.body.trim()}\n\n`
  );
}
