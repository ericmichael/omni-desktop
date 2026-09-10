// Slash commands as the client sees them, and the one rule for turning a
// typed line into a call. The server publishes the typeable subset of its
// functions through `server_call("slash.list")`; a client adds its own
// local commands in the same shape and renders nothing else.
//
// The rule (shared with the web UI and Desktop, each in its own copy):
//   - a leading space, or a slash inside the name, means plain text;
//   - otherwise the name is looked up (aliases included);
//   - the rest of the line is mapped by the command's argument rule —
//     none / text(field) / words(fields...) — never JSON;
//   - an unknown name is refused, never sent to the model.

export type SlashArgsRule = { kind: 'none' } | { kind: 'text'; field: string } | { kind: 'words'; fields: string[] };

export type SlashCommand = {
  /** Typed name, without the slash. */
  name: string;
  /** Server function to call, or null for a client-side command. */
  function: string | null;
  description: string;
  usage: string;
  args: SlashArgsRule;
  aliases: string[];
  /** False: refuse while a run is active. */
  during_run: boolean;
  /** Presentation order; lower first. */
  order: number;
  source: 'server' | 'client';
};

export type ParsedSlashLine = { name: string; rest: string };

/** `/name rest` → parts, or null when the text is not a command. */
export function parseSlashLine(text: string): ParsedSlashLine | null {
  if (!text.startsWith('/')) {
    return null;
  } // a leading space opts out
  const match = /^\/(\S*)([\s\S]*)$/.exec(text);
  if (!match) {
    return null;
  }
  const name = (match[1] ?? '').toLowerCase();
  if (!name || name.includes('/')) {
    return null;
  } // `/usr/bin/ls` is a path
  return { name, rest: (match[2] ?? '').trim() };
}

export function findSlashCommand(commands: readonly SlashCommand[], name: string): SlashCommand | undefined {
  const needle = name.toLowerCase();
  return commands.find((command) => command.name === needle || command.aliases.includes(needle));
}

export type SlashArgsResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

export function parseSlashArgs(rule: SlashArgsRule, rest: string): SlashArgsResult {
  const text = rest.trim();
  switch (rule.kind) {
    case 'none':
      return text ? { ok: false, error: 'This command takes no arguments.' } : { ok: true, args: {} };
    case 'text':
      return { ok: true, args: text ? { [rule.field]: text } : {} };
    case 'words': {
      if (!text || rule.fields.length === 0) {
        return { ok: true, args: {} };
      }
      const args: Record<string, unknown> = {};
      let remaining = text;
      rule.fields.forEach((field, index) => {
        if (!remaining) {
          return;
        }
        if (index === rule.fields.length - 1) {
          args[field] = remaining;
          remaining = '';
          return;
        }
        const cut = remaining.search(/\s/);
        if (cut === -1) {
          args[field] = remaining;
          remaining = '';
        } else {
          args[field] = remaining.slice(0, cut);
          remaining = remaining.slice(cut).trim();
        }
      });
      return { ok: true, args };
    }
  }
}

export const takesArgs = (command: SlashCommand): boolean => command.args.kind !== 'none';

/** The composer text for a chosen command: a trailing space when it
 * expects arguments, so the cursor lands where they go. */
export function completionFor(command: SlashCommand): string {
  return takesArgs(command) ? `/${command.name} ` : `/${command.name}`;
}

export function unknownCommandMessage(name: string): string {
  return `Unrecognized command '/${name}'. Type / for a list of commands.`;
}

/** Validate and normalise one catalog row from `slash.list`. */
export function normalizeSlashCommand(row: unknown): SlashCommand | null {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const record = row as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim().toLowerCase() : '';
  if (!name) {
    return null;
  }
  const rawArgs = (record.args ?? { kind: 'none' }) as Record<string, unknown>;
  let args: SlashArgsRule = { kind: 'none' };
  if (rawArgs.kind === 'text') {
    args = {
      kind: 'text',
      field: typeof rawArgs.field === 'string' ? rawArgs.field : 'text',
    };
  } else if (rawArgs.kind === 'words') {
    args = {
      kind: 'words',
      fields: Array.isArray(rawArgs.fields) ? rawArgs.fields.filter((f): f is string => typeof f === 'string') : [],
    };
  }
  return {
    name,
    function: typeof record.function === 'string' ? record.function : name,
    description: typeof record.description === 'string' ? record.description.trim() : '',
    usage: typeof record.usage === 'string' ? record.usage.trim() : '',
    args,
    aliases: Array.isArray(record.aliases)
      ? record.aliases.filter((a): a is string => typeof a === 'string').map((a) => a.toLowerCase())
      : [],
    during_run: record.during_run !== false,
    order: typeof record.order === 'number' ? record.order : 100,
    source: 'server',
  };
}

/**
 * The text a client shows for a slash command's result. A string is the
 * message; an object's string `message` (or `text`) is; anything else is
 * 'Done.' A client never puts JSON into the conversation.
 */
export function slashResultMessage(result: unknown): string {
  if (typeof result === "string") return result.trim() || 'Done.';
  if (result && typeof result === "object") {
    const r = result as { message?: unknown; text?: unknown };
    if (typeof r.message === "string" && r.message.trim()) return r.message;
    if (typeof r.text === "string" && r.text.trim()) return r.text;
  }
  return 'Done.';
}
