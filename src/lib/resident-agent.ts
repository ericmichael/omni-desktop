/**
 * Resident agents — pure core (no Electron/node imports).
 *
 * The mechanisms here are ports of the Weirbrook NPC substrate
 * (docs/resident-agents-plan.md): delta wakeup pings, WAKE_NOW vs digest
 * event classification, the count-based DM round budget, nightly
 * reflection parsing with value-based `forget`, and the identity
 * instructions render. The main-process manager
 * (src/main/resident-agent-manager.ts) owns all I/O; everything in this
 * module is a pure function over plain data so it unit-tests directly.
 */

import type { ResidentAgent, ResidentChannelDef, ResidentChannelMessage, ResidentMemoryEntry } from '@/shared/types';

/** Reserved ProcessManager id prefix, alongside `"chat"` and `"global"`. */
export const RESIDENT_PROCESS_PREFIX = 'agent:';

export const residentProcessId = (agentId: string): string => `${RESIDENT_PROCESS_PREFIX}${agentId}`;

/**
 * Principal id a resident acts as against the omni-projects MCP server —
 * deliberately the same `agent:<rosterId>` namespace as the process id, so
 * one string identifies the agent in both worlds and can never collide with
 * human principal ids (docs/residents-in-projects-db-plan.md).
 */
export const residentPrincipalId = (agentId: string): string => `${RESIDENT_PROCESS_PREFIX}${agentId}`;

/** Roster id from a resident principal/process id; null for anything else
 *  (human principals, 'user', unassigned). Nothing parses the prefix ad hoc. */
export const parseResidentPrincipal = (principal: string | null | undefined): string | null =>
  principal && principal.startsWith(RESIDENT_PROCESS_PREFIX) ? principal.slice(RESIDENT_PROCESS_PREFIX.length) : null;

/** Whether a ProcessManager process id belongs to a resident agent. */
export const isResidentProcessId = (processId: string): boolean => processId.startsWith(RESIDENT_PROCESS_PREFIX);

/** The user's stable participant id in channels. */
export const USER_PARTICIPANT = 'user';

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The agent's @address, derived from its CURRENT display name — rename the
 * agent and the address follows. Durable identity lives in the opaque
 * `res_*` id (never shown, never typed); the handle is pure addressing:
 * mention matching, `dm(to)` targets, and UI display. Handles must be
 * unique across the roster (enforced at create/rename), which is why two
 * agents cannot share a name.
 */
export const residentHandle = (name: string): string => slugify(name) || 'agent';

/** Channel id from a display name (`#Deploy Log` → `deploy-log`). */
export const channelIdFromName = (name: string): string => slugify(name.replace(/^#/, '')) || 'channel';

/** Memory key from arbitrary input (`User's Deploy Window` → `users-deploy-window`).
 *  Empty result = invalid input; the tool fulfiller surfaces a corrective error. */
export const memoryKey = (raw: string): string => slugify(raw).slice(0, 64).replace(/-+$/, '');

/** The built-in shared channel, always present. Named channels sit beside
 *  it; DM channels are `dm:<a>:<b>` (sorted pair); `system` is the
 *  user-facing incident log agents never read. */
export const TEAM_CHANNEL = 'team';
export const SYSTEM_CHANNEL = 'system';

/** Ids no roster member or named channel may claim. */
export const RESERVED_CHANNEL_IDS: readonly string[] = [TEAM_CHANNEL, SYSTEM_CHANNEL, USER_PARTICIPANT];

/**
 * The named channels `agentId` belongs to (Slack membership): always
 * `#team` (all-hands), plus every def whose member list includes the
 * agent — or has no member list at all (absent = open to everyone).
 */
export const memberChannelIds = (
  defs: ReadonlyArray<Pick<ResidentChannelDef, 'id' | 'members'>>,
  agentId: string
): string[] => [TEAM_CHANNEL, ...defs.filter((d) => !d.members || d.members.includes(agentId)).map((d) => d.id)];

/** Canonical DM channel id for a participant pair (order-insensitive). */
export const dmChannelId = (a: string, b: string): string => {
  const [x, y] = [a, b].sort();
  return `dm:${x}:${y}`;
};

/** The two participants of a DM channel id, or null for non-DM channels. */
export const dmParticipants = (channel: string): [string, string] | null => {
  if (!channel.startsWith('dm:')) {
    return null;
  }
  const rest = channel.slice(3);
  const sep = rest.indexOf(':');
  if (sep <= 0) {
    return null;
  }
  return [rest.slice(0, sep), rest.slice(sep + 1)];
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * One thing that happened to a resident agent. `wake_now` kinds start a
 * turn immediately; everything else rides along as digest rows on the
 * next natural wakeup (the game's WAKE_NOW_KINDS split — direct address
 * and the day's spine wake now, ambient traffic never does).
 */
export type ResidentEvent = {
  kind:
    | 'dm'
    | 'mention'
    | 'channel_user'
    | 'thread_reply'
    | 'wake'
    | 'day_start'
    | 'channel_post'
    | 'catch_up'
    | 'scheduled'
    | 'assignment'
    | 'column_done';
  /** Participant id that caused the event, when there is one. */
  from?: string;
  /** Message text, when the event carries one. */
  text?: string;
  /** Channel id, for channel-scoped kinds (mention / channel_user / thread_reply / channel_post). */
  channel?: string;
  /** Id of the channel message that caused this event — what the agent
   *  passes as `reply_to` to answer it in a thread. */
  messageId?: number;
  /** Thread context for `thread_reply`: an excerpt of the thread's root. */
  rootText?: string;
  /** Freeform detail line for non-message events. */
  detail?: string;
};

const WAKE_NOW_KINDS: ReadonlySet<ResidentEvent['kind']> = new Set([
  'dm', // direct message to this agent (user or another agent)
  'mention', // named in a channel
  'channel_user', // the user spoke on a channel — a human is deliberately talking
  'thread_reply', // someone answered in a thread this agent is part of
  'wake', // manual wake from the UI
  'day_start',
  'catch_up', // digest backlog aged out — the eventual-delivery guarantee
  'scheduled', // a self-set alarm fired (the game's plan() appointments)
  'assignment', // a ticket was assigned to this agent — direct delegation
  'column_done', // a column run this agent dispatched (column_send) ended
]);

export const isWakeNow = (event: ResidentEvent): boolean => WAKE_NOW_KINDS.has(event.kind);

// ---------------------------------------------------------------------------
// Sessions & days
// ---------------------------------------------------------------------------

/** Local-time day key, `YYYY-MM-DD`. The day boundary is local midnight. */
export const dayKey = (ts: number): string => {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

/** One session per agent per calendar day — continuity across days lives in
 *  durable memory, not transcript (the plan's no-infinite-compaction call). */
export const daySessionId = (agentId: string, key: string): string => `resident-${agentId}-${key}`;

/** Whether a serve session id belongs to a resident agent — the stable serve
 *  session (`resident-<id>`) or a day session (`resident-<id>-YYYY-MM-DD`).
 *  User chat sessions are UUIDs, so the prefix cannot collide. */
export const isResidentSessionId = (sessionId: string): boolean => sessionId.startsWith('resident-');

// ---------------------------------------------------------------------------
// DM round budget (agent↔agent pacing)
// ---------------------------------------------------------------------------

/**
 * Per-pair thread state. Count-based on purpose (the game's soak lesson:
 * a wall-clock budget changes meaning with load; a round budget bounds
 * the LLM cost of a conversation absolutely).
 */
export type ThreadState = {
  /** Delivered wakeup rounds in the current conversation. */
  rounds: number;
  /** Wall-clock ms of the last delivered round (0 = never). */
  lastDeliveredAt: number;
};

export const THREAD_RESET_MS = 30 * 60_000; // silence that starts a fresh conversation
export const THREAD_BASE_DELAY_MS = 60_000; // batching slot for a live thread
// Sized for working agents coordinating on real tasks (a reviewer↔engineer
// exchange runs long) — the budget only exists to stop two LLMs looping,
// not to pace conversation.
const THREAD_WINDING_START = 8; // rounds at which the prompt stops urging a reply
const THREAD_PENPAL_AFTER = 12; // rounds after which lines land as digest only

export type ThreadUrge = 'reply' | 'winding_down' | 'none';

export type ThreadDelivery =
  | { mode: 'now'; urge: ThreadUrge }
  | { mode: 'delay'; delayMs: number; urge: ThreadUrge }
  | { mode: 'digest' };

/**
 * How an agent→agent DM should reach its recipient, given the pair's
 * thread state. First contact (or post-silence) lands immediately;
 * a live thread batches on a delivery slot with gaps stretching over the
 * last two rounds before the budget; past `THREAD_PENPAL_AFTER` rounds the
 * thread is pen-pal mail — rows land in digests but wake nobody until
 * `THREAD_RESET_MS` of silence.
 */
export const nextThreadDelivery = (state: ThreadState | undefined, nowMs: number): ThreadDelivery => {
  const s = state ?? { rounds: 0, lastDeliveredAt: 0 };
  const idle = s.lastDeliveredAt === 0 || nowMs - s.lastDeliveredAt >= THREAD_RESET_MS;
  if (idle) {
    return { mode: 'now', urge: 'reply' };
  }
  const nextRound = s.rounds + 1;
  if (nextRound > THREAD_PENPAL_AFTER) {
    return { mode: 'digest' };
  }
  const urge: ThreadUrge = nextRound >= THREAD_WINDING_START ? 'winding_down' : 'reply';
  const stretch = nextRound === THREAD_PENPAL_AFTER - 1 ? 2 : nextRound === THREAD_PENPAL_AFTER ? 4 : 1;
  return { mode: 'delay', delayMs: THREAD_BASE_DELAY_MS * stretch, urge };
};

/** Record a delivered round (resets first when the silence window passed). */
export const advanceThread = (state: ThreadState | undefined, nowMs: number): ThreadState => {
  const s = state ?? { rounds: 0, lastDeliveredAt: 0 };
  const idle = s.lastDeliveredAt === 0 || nowMs - s.lastDeliveredAt >= THREAD_RESET_MS;
  return { rounds: idle ? 1 : s.rounds + 1, lastDeliveredAt: nowMs };
};

// ---------------------------------------------------------------------------
// Speech client tools (the agent's speech channel)
// ---------------------------------------------------------------------------

/**
 * Resident agents speak through CLIENT TOOLS — real function tools,
 * declared per session via `variables.client_tools` and fulfilled by the
 * manager's watcher over the `client_request`/`client_response` protocol
 * (the same mechanism chat columns use, with the watcher as the client).
 * Speech is therefore an ACTION taken mid-turn — validated, budgeted,
 * and delivered while the run is still going, exactly like the game's
 * say/whisper/chat tools. Silence is simply not calling them.
 */
export type ClientToolDef = {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
};

export const SPEECH_TOOL_NAMES: readonly string[] = ['post_channel', 'dm', 'schedule', 'remember', 'forget'];

/** Build the speech tool defs. `channels` (current named channels) rides in
 *  the description for discoverability; validation errors list the live set
 *  either way, so a channel created mid-session is still reachable. */
export const speechClientTools = (channels: readonly string[]): ClientToolDef[] => [
  {
    name: 'post_channel',
    description:
      `Post a message to a shared channel (the user and every teammate can read it). ` +
      `Channels: ${channels.map((c) => `#${c}`).join(', ')}. Teammates see plain posts on ` +
      `their next wakeup; a plain post never interrupts anyone. To answer a specific ` +
      `message, pass its id (the [N] in your wakeups) as reply_to — the reply threads ` +
      `under that message and wakes the thread's participants.`,
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id, without the # (e.g. "team").' },
        text: { type: 'string', description: 'The message to post.' },
        reply_to: {
          type: 'integer',
          description:
            'Optional: id of the message you are answering. Threads the reply under ' +
            "that message's root and wakes the thread's participants.",
        },
      },
      required: ['channel', 'text'],
    },
  },
  {
    name: 'dm',
    description:
      'Send a direct message to the user (`to: "user"`) or a teammate (`to: <teammate handle>`). ' +
      'Teammate DMs are paced — a long back-and-forth cools off; let closers rest.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient: "user" or a teammate\'s @handle (with or without the @).' },
        text: { type: 'string', description: 'The message to send.' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'schedule',
    description:
      'Schedule a wakeup for your future self: you will be woken in `minutes` with ' +
      'your note. Use it for follow-ups and intentions that outlive this turn ' +
      '("check the CI run", "nudge scout tomorrow morning"). One-shot; it survives ' +
      'you being wound down between wakeups.',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'integer', description: 'Minutes from now (1 to 10080 — one week).' },
        note: { type: 'string', description: 'What future-you needs to know or do.' },
      },
      required: ['minutes', 'note'],
    },
  },
  {
    name: 'remember',
    description:
      'Save (or update) a durable memory — a fact you will still act on tomorrow. ' +
      'Keyed: the same key overwrites, so refine rather than duplicate. Your current ' +
      'memories are listed in your instructions as `[key] text`. Good keys are short ' +
      'stable slugs ("user-report-style", "deploy-window"). The test for saving: ' +
      'will future-you act differently because of it?',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Stable slug identity for this fact (e.g. "deploy-window").' },
        text: { type: 'string', description: 'One line — the fact worth carrying forward.' },
      },
      required: ['key', 'text'],
    },
  },
  {
    name: 'forget',
    description:
      'Retract a durable memory that was proven wrong or is obsolete. ' +
      'Pass the `[key]` shown beside it in your instructions.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key of the memory to remove.' },
      },
      required: ['key'],
    },
  },
];

/** Does a #team post name this agent (by id or display name)? */
export const mentionsAgent = (text: string, agent: Pick<ResidentAgent, 'name'>): boolean => {
  const hay = text.toLowerCase();
  const needles = [residentHandle(agent.name), agent.name.toLowerCase()].filter((n) => n.length > 0);
  return needles.some((n) => hay.includes(`@${n}`) || new RegExp(`\\b${escapeRe(n)}\\b`).test(hay));
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Wakeup ping rendering
// ---------------------------------------------------------------------------

export type DigestRow = {
  /** Message id — what a reply targets via `post_channel(..., reply_to)`. */
  id: number;
  channel: string;
  from: string;
  text: string;
  agoMin: number;
  /** Thread root id when this row is a reply. */
  replyTo?: number;
  /** Excerpt of the thread root, when it is still in the log. */
  rootExcerpt?: string;
};

export type WakeupRender = {
  nowMs: number;
  agent: Pick<ResidentAgent, 'id' | 'name'>;
  events: ResidentEvent[];
  /** Unread channel rows since the agent's cursor (its own posts excluded). */
  digest: DigestRow[];
  /** Names of the other roster members, for the address protocol. */
  roster: Array<Pick<ResidentAgent, 'id' | 'name'>>;
  /** Winding-down flag for the DM thread that triggered this wakeup. */
  threadUrge?: ThreadUrge;
  /** Older digest rows omitted by the per-channel cap. */
  droppedRows?: number;
  /** One-line system notes to the agent (e.g. speech-cap feedback). */
  notices?: string[];
  /** Named channels the agent can post to (team + user-created). */
  channels?: string[];
  /** Pending self-set alarms, pre-formatted ("14:30 — check the CI run"). */
  appointments?: string[];
};

const eventLine = (e: ResidentEvent): string => {
  const ch = `#${e.channel ?? TEAM_CHANNEL}`;
  // Channel messages carry their id so the agent can thread a reply onto
  // them (`post_channel(..., reply_to: N)`). DMs are flat — no id bait.
  const id = e.messageId !== undefined ? ` [msg ${e.messageId}]` : '';
  switch (e.kind) {
    case 'dm':
      return `${e.from ?? '?'} sent you a direct message: "${e.text ?? ''}"`;
    case 'mention':
      return `${e.from ?? '?'} mentioned you on ${ch}${id}: "${e.text ?? ''}"`;
    case 'channel_user':
      return `the user posted on ${ch}${id}: "${e.text ?? ''}"`;
    case 'thread_reply':
      return `${e.from ?? '?'} replied in a thread you're in on ${ch}${id}: "${e.text ?? ''}"${
        e.rootText ? ` (thread: "${e.rootText}")` : ''
      }`;
    case 'channel_post':
      return `${e.from ?? '?'} posted on ${ch}${id}: "${e.text ?? ''}"`;
    case 'wake':
      return e.detail ?? 'the user woke you from the roster panel';
    case 'day_start':
      // A late (caught-up) beat carries a detail line with the real clock.
      return e.detail ?? 'a new working day begins';
    case 'catch_up':
      return 'unread messages have been waiting a while — catch up on the digest below';
    case 'scheduled':
      return `you told yourself: "${e.text ?? ''}"`;
    case 'assignment':
      // The detail carries the ticket reference; the agent pulls the full
      // ticket through the project tools (get_ticket) — delta, not dump.
      return e.detail ?? 'a ticket was assigned to you — check your tickets';
    case 'column_done':
      // The detail carries the column reference; the agent reads the outcome
      // through column_transcript — delta, not dump.
      return e.detail ?? 'an agent you dispatched to a workspace column finished its run';
  }
};

/**
 * The per-turn message is a delta PING, never a state dump: when and why
 * you woke and what is new since your cursor. Long-held memories live in
 * the identity `additional_instructions` (fresh every wake), not here.
 * Everything else is pull-based through the workspace tools — the plan's
 * load-bearing cost decision (Weirbrook: full re-render was 68% of
 * stored context).
 */
export const renderWakeupPing = (w: WakeupRender): string => {
  const d = new Date(w.nowMs);
  const clock = `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
  const parts: string[] = [];
  parts.push(`[wakeup] ${dayKey(w.nowMs)} ${clock} — you woke up.`);

  const lines = w.events.map((e) => `- ${eventLine(e)}`);
  parts.push(`\n## WHY YOU WOKE\n${lines.length > 0 ? lines.join('\n') : '- (a quiet check-in)'}`);

  // Group unread rows by channel — named channels first (team leading),
  // then the DM section. Every row leads with its [id] so the agent can
  // thread a reply onto it; replies carry their root for context.
  const row = (r: DigestRow): string => {
    const re = r.replyTo !== undefined ? ` ↳ re [${r.replyTo}]${r.rootExcerpt ? ` "${r.rootExcerpt}"` : ''}` : '';
    return `- [${r.id}] ${r.from}${re}: ${r.text}${r.agoMin > 0 ? ` (${r.agoMin}m ago)` : ''}`;
  };
  const channelIds = [...new Set(w.digest.filter((r) => !r.channel.startsWith('dm:')).map((r) => r.channel))].sort(
    (a, b) => (a === TEAM_CHANNEL ? -1 : b === TEAM_CHANNEL ? 1 : a.localeCompare(b))
  );
  for (const channel of channelIds) {
    const rows = w.digest.filter((r) => r.channel === channel);
    parts.push(`\n## NEW IN #${channel} (unread since you last woke)\n${rows.map(row).join('\n')}`);
  }
  const dmRows = w.digest.filter((r) => r.channel.startsWith('dm:'));
  if (dmRows.length > 0) {
    parts.push(`\n## NEW DIRECT MESSAGES\n${dmRows.map(row).join('\n')}`);
  }
  if ((w.droppedRows ?? 0) > 0) {
    parts.push(`(${w.droppedRows} earlier unread message${w.droppedRows === 1 ? '' : 's'} omitted to keep this short)`);
  }

  if ((w.notices?.length ?? 0) > 0) {
    parts.push(`\n## NOTICES\n${(w.notices ?? []).map((n) => `- ${n}`).join('\n')}`);
  }

  if ((w.appointments?.length ?? 0) > 0) {
    parts.push(
      `\n## YOUR UPCOMING REMINDERS (self-set via schedule)\n${(w.appointments ?? []).map((a) => `- ${a}`).join('\n')}`
    );
  }

  if (w.threadUrge === 'winding_down') {
    parts.push(
      `\n-> This thread has run long. Reply ONLY if you have something genuinely ` +
        `new to say. A closer ("thanks", "got it") needs NO answer — let the ` +
        `thread rest and get on with your work.`
    );
  }

  const others = w.roster.filter((r) => r.id !== w.agent.id);
  parts.push(
    `\nThat is everything new. Your workspace and tools hold all other state — ` +
      `read them when you need them.\n` +
      `To say something, use your speech tools: \`post_channel(channel, text, reply_to?)\` for a ` +
      `shared channel (${(w.channels ?? [TEAM_CHANNEL]).map((c) => `\`#${c}\``).join(', ')}), ` +
      `\`dm(to, text)\` for the user (\`to: "user"\`)${
        others.length > 0 ? ` or a teammate (${others.map((r) => `\`${residentHandle(r.name)}\``).join(', ')})` : ''
      }. To answer a specific message, pass its [id] as \`reply_to\` — a threaded reply ` +
      `wakes that thread's participants, while a plain post never interrupts anyone. ` +
      `Your final reply is private notes-to-self — only the tools are heard. ` +
      `Work first, speak only when it adds something. Nothing is owed this turn: ` +
      `if this wakeup needs nothing from you, call no speech tool and end your turn.`
  );
  return parts.join('\n');
};

// ---------------------------------------------------------------------------
// Nightly reflection
// ---------------------------------------------------------------------------

export type ReflectionInput = {
  day: string;
  agentName: string;
  /** The day's episodic lines (channel traffic seen, wakeup reasons, posts made). */
  episodic: string[];
  /** Snapshot of long-held memories, shown with their keys. */
  durable: Array<Pick<ResidentMemoryEntry, 'key' | 'text'>>;
};

/**
 * The nightly curation beat. Memory writes happen through the
 * `remember`/`forget` client tools DURING this run — validated at the
 * call site with corrective errors, no output parsing. The prompt's job
 * is only to set the distillation bar.
 */
export const renderReflectPrompt = (r: ReflectionInput): string => {
  const episodic =
    r.episodic.length > 0 ? r.episodic.map((e) => `- ${e}`).join('\n') : '- (a quiet day — little was recorded)';
  const durable = r.durable.length > 0 ? r.durable.map((m) => `- [${m.key}] ${m.text}`).join('\n') : '(none yet)';
  return (
    `The working day (${r.day}) is over. Before it is archived, reflect on it.\n\n` +
    `## TODAY'S RECORD\n${episodic}\n\n` +
    `## LONG-HELD MEMORIES\n${durable}\n\n` +
    `Run back through the day and keep ONLY what is truly worth carrying ` +
    `forward. The test: will tomorrow-you act differently because of it? ` +
    `Commitments made, decisions and their rationale, what failed and WHY, ` +
    `preferences the user expressed, exact names and numbers.\n\n` +
    `Curate with your memory tools, now, in this turn:\n` +
    `- \`remember(key, text)\` — save a fact; re-using a key refines that entry in place.\n` +
    `- \`forget(key)\` — retract an entry proven wrong or gone stale.\n` +
    `Most days need one to three saves; a quiet day may need none. Your final ` +
    `reply is private notes-to-self — only the tool calls change anything.`
  );
};

// ---------------------------------------------------------------------------
// Identity render (persona → session `additional_instructions`)
// ---------------------------------------------------------------------------

/**
 * The agent's standing identity — persona, durable memory, roster, and
 * conduct rules. Delivered as the session's `additional_instructions`
 * via `session.ensure` (the same channel autopilot's supervisor prompt
 * and voice personas ride), so it renders directly into the system
 * prompt on every wake — no file seeding, no snapshot staleness.
 * Persona is prior; memories are posterior and may override it.
 */
export const renderIdentityInstructions = (
  agent: Pick<ResidentAgent, 'id' | 'name' | 'role' | 'personaText' | 'superuser'>,
  memories: ResidentMemoryEntry[],
  roster: Array<Pick<ResidentAgent, 'id' | 'name' | 'role'>>,
  assignment?: {
    /** Scoped projects: display label + the mount names their sources land under. */
    projects: Array<{ label: string; mountNames: string[] }>;
    /** Mount name the agent's private home rides under next to the project sources. */
    homeMount: string;
  },
  /** The shared team handbook body (handbook-first: injected on every wake). */
  handbook?: string
): string => {
  const others = roster.filter((r) => r.id !== agent.id);
  const parts: string[] = [];
  parts.push(`# ${agent.name} — ${agent.role}`);
  const projectLine = (p: { label: string; mountNames: string[] }): string =>
    p.mountNames.length > 0
      ? `- **${p.label}** — ${p.mountNames.map((m) => `\`${m}/\``).join(', ')}`
      : `- **${p.label}** — no mounted sources; work with it through the project tools`;
  const homeLine = assignment
    ? `You are responsible for ${assignment.projects.length === 1 ? 'this project' : 'these projects'}, ` +
      `mounted in this workspace:\n${assignment.projects.map(projectLine).join('\n')}\n` +
      `Work happens in those mounts. Your private home folder rides along as the ` +
      `\`${assignment.homeMount}/\` mount: files you keep there persist across days ` +
      `and rescoping. Mounted sources are seeded at launch — for git repos, fetch/pull ` +
      `to pick up what happened since.`
    : `This workspace is your home directory: your files persist here across days.`;
  parts.push(
    `\nYou are ${agent.name} (address \`@${residentHandle(agent.name)}\`), a resident agent on the user's ` +
      `roster. ${homeLine} You are woken by events (messages, mentions, schedules); ` +
      `between wakeups you do not exist. Each wakeup tells you only what is new — ` +
      `your session history and these standing instructions carry everything else.`
  );
  if (agent.personaText.trim()) {
    parts.push(`\n## Who you are\n${agent.personaText.trim()}`);
  }
  if (agent.superuser) {
    parts.push(
      `\n## You are the workspace orchestrator\n` +
        `Beyond your own workspace, you hold superuser tools over the user's Tile deck — ` +
        `the columns of agent sessions in their app.\n` +
        `- \`list_workspace\` is your map: open columns, their sessions, bound project/ticket, and run state. ` +
        `\`list_apps\` shows every app across all columns (each with a \`handle_id\`) plus the global dock apps.\n` +
        `- Act inside a column with \`column_send\` (instruct its agent), \`column_decide\` (approve/reject what ` +
        `it is blocked on), \`column_cancel\` (stop it), and \`start_ticket\` / \`stop_ticket\` (autopilot). ` +
        `Shape the deck with \`open_column\`, \`close_column\`, and \`launch_app\`.\n` +
        `- Drive any column's apps with the \`app_*\` tools using the \`handle_id\` from \`list_apps\` — not a ` +
        `bare name, because the same app (e.g. \`terminal\`) exists in many columns.\n` +
        `- When you dispatch work with \`column_send\`, you are woken when that run ends — no need to poll.\n` +
        `- These tools live in the user's app window: when it is closed they return an error. That is normal — ` +
        `note it, work with what you have, and try again later.\n` +
        `- Report through your speech tools like everything else (\`dm\` the user, post to channels). ` +
        `Confirm with the user before anything destructive (closing a column, cancelling a run).`
    );
  }
  if (handbook?.trim()) {
    parts.push(
      `\n## Team handbook\nShared rules for the whole roster — they bind every agent and ` +
        `override persona where they conflict. Maintained in the DB via ` +
        `\`read_handbook\`/\`update_handbook\`; edits reach everyone on their next wake.\n\n${handbook.trim()}`
    );
  }
  if (others.length > 0) {
    parts.push(
      `\n## Your teammates\n${others
        .map((r) => `- ${r.name} (\`@${residentHandle(r.name)}\`) — ${r.role}`)
        .join('\n')}\nCoordinate through #team and direct messages; delegate real work by ` +
        `asking, and verify outcomes yourself rather than assuming.`
    );
  }
  if (memories.length > 0) {
    parts.push(
      `\n## What you have learned (durable memory — trust this over assumptions)\n${memories
        .map((m) => `- [${m.key}] ${m.text}`)
        .join('\n')}\nMaintain these with \`remember(key, text)\` (same key updates in place) and ` +
        `\`forget(key)\` when an entry is proven wrong.`
    );
  } else {
    parts.push(
      `\n## What you have learned\nNothing recorded yet. When you learn something ` +
        `future-you should act on, save it with \`remember(key, text)\`.`
    );
  }
  parts.push(
    `\n## How you act\n` +
      `- Nothing is owed on a wakeup: work, speak, or simply end your turn.\n` +
      `- Speak ONLY through your speech tools — \`post_channel(channel, text, reply_to?)\` for a ` +
      `shared channel, \`dm(to, text)\` for the user or a teammate. Plain reply text ` +
      `is heard by no one.\n` +
      `- Don't answer a closer; don't thank a thanks. Silence ends a thread fine.\n` +
      `- Anything with side effects goes through your tools — never claim work you ` +
      `did not verifiably do.`
  );
  return `${parts.join('\n')}\n`;
};

/**
 * Seed handbook, written once when no handbook exists yet. Every rule here
 * was earned by an observed failure (docs/residents-in-projects-db-plan.md
 * and the 2026-07-24 review-handoff episode); the roster edits it from here.
 */
export const DEFAULT_TEAM_HANDBOOK = `### Code & workspaces
- Your workspace is YOURS ALONE. Teammates cannot see your files, diffs, or local commits — every agent runs in its own sandbox.
- Code reaches a teammate only as a pushed remote branch. Handoff format: \`repo: <url> | branch: origin/<name> | commit: <sha>\`.
- Commit early. Uncommitted work may not survive your run; never claim verification of work that isn't committed.

### Communication
- Post once, where the work lives (the ticket). Link it elsewhere only if someone must act. No FYI-only pings.
- Every request stands alone: explicit ask, one owner, the ids/links needed to act without reading a thread.
- After delegating, wait. Delivery is guaranteed — re-asking creates duplicate work. Never do the work you delegated.
- Decisions and evidence go in ticket comments, not chat. Chat summarizes and links.

### Review
- The reviewer fetches the exact remote branch/commit and verifies independently. Local paths are never a review artifact.
- A ticket enters Review only when its pushed branch exists.`;

// ---------------------------------------------------------------------------
// Digest cursors
// ---------------------------------------------------------------------------

/**
 * Unread channel rows for an agent: everything after its cursor that it
 * can see (#team plus its own DM channels), excluding its own posts.
 */
/** Max digest rows per channel in one wakeup (the game's ≤8-per-channel
 *  guard — an unbounded digest is an unbounded prompt). Newest rows win;
 *  the ping reports how many older rows were omitted. */
export const MAX_DIGEST_ROWS_PER_CHANNEL = 8;

/** Root excerpt length carried on reply digest rows. */
const ROOT_EXCERPT_LEN = 60;

export const unreadRowsFor = (
  log: ResidentChannelMessage[],
  agentId: string,
  cursor: number,
  nowMs: number,
  /** Named channels this agent belongs to (from `memberChannelIds`). */
  memberChannels: readonly string[]
): { rows: DigestRow[]; nextCursor: number; dropped: number } => {
  let nextCursor = cursor;
  const all: DigestRow[] = [];
  // Thread roots may be older than the cursor — resolve excerpts against
  // the full log (a pruned root simply yields no excerpt).
  const textById = new Map(log.map((m) => [m.id, m.text]));
  for (const msg of log) {
    if (msg.id <= cursor) {
      continue;
    }
    nextCursor = Math.max(nextCursor, msg.id);
    if (msg.from === agentId) {
      continue;
    }
    // Visible: channels the agent is a MEMBER of, plus its own DM threads.
    // Everything else — other channels, `system`, others' DMs — is not this
    // agent's to read; the cursor still advances past it so it never
    // resurfaces on a later membership change.
    const dm = dmParticipants(msg.channel);
    if (dm ? !dm.includes(agentId) : !memberChannels.includes(msg.channel)) {
      continue;
    }
    const rootText = msg.replyTo !== undefined ? textById.get(msg.replyTo) : undefined;
    all.push({
      id: msg.id,
      channel: msg.channel,
      from: msg.fromName ?? msg.from,
      text: msg.text,
      agoMin: Math.max(0, Math.floor((nowMs - msg.at) / 60_000)),
      ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
      ...(rootText ? { rootExcerpt: rootText.slice(0, ROOT_EXCERPT_LEN) } : {}),
    });
  }
  // Cap per channel, keeping the NEWEST rows (log order is chronological).
  const kept = new Map<string, number>();
  const rows: DigestRow[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const row = all[i];
    if (!row) {
      continue;
    }
    const n = kept.get(row.channel) ?? 0;
    if (n < MAX_DIGEST_ROWS_PER_CHANNEL) {
      kept.set(row.channel, n + 1);
      rows.unshift(row);
    }
  }
  return { rows, nextCursor, dropped: all.length - rows.length };
};
