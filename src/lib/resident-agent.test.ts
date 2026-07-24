import { describe, expect, it } from 'vitest';

import {
  advanceThread,
  dayKey,
  daySessionId,
  dmChannelId,
  dmParticipants,
  isWakeNow,
  MAX_DIGEST_ROWS_PER_CHANNEL,
  memberChannelIds,
  memoryKey,
  mentionsAgent,
  nextThreadDelivery,
  renderIdentityInstructions,
  renderReflectPrompt,
  renderWakeupPing,
  SPEECH_TOOL_NAMES,
  speechClientTools,
  THREAD_BASE_DELAY_MS,
  THREAD_RESET_MS,
  type ThreadState,
  unreadRowsFor,
} from '@/lib/resident-agent';
import type { ResidentChannelMessage } from '@/shared/types';

describe('event classification', () => {
  it('wakes now on direct address and the day spine', () => {
    expect(isWakeNow({ kind: 'dm', from: 'user', text: 'hi' })).toBe(true);
    expect(isWakeNow({ kind: 'mention', from: 'user', text: '@scout look' })).toBe(true);
    expect(isWakeNow({ kind: 'channel_user', from: 'user', text: 'morning all' })).toBe(true);
    expect(isWakeNow({ kind: 'wake' })).toBe(true);
    expect(isWakeNow({ kind: 'day_start' })).toBe(true);
  });

  it('agent team posts ride the digest', () => {
    expect(isWakeNow({ kind: 'channel_post', from: 'scout', text: 'done' })).toBe(false);
  });

  it('a threaded reply to you wakes now', () => {
    expect(isWakeNow({ kind: 'thread_reply', from: 'archivist', text: 'found it', channel: 'team' })).toBe(true);
  });

  it('a stale-backlog catch-up wakes now', () => {
    expect(isWakeNow({ kind: 'catch_up' })).toBe(true);
  });

  it('a self-set alarm wakes now', () => {
    expect(isWakeNow({ kind: 'scheduled', text: 'check the CI run' })).toBe(true);
  });
});

describe('channels', () => {
  it('dm channel ids are order-insensitive', () => {
    expect(dmChannelId('user', 'scout')).toBe(dmChannelId('scout', 'user'));
    expect(dmParticipants(dmChannelId('a', 'b'))).toEqual(['a', 'b']);
    expect(dmParticipants('team')).toBeNull();
  });
});

describe('sessions & days', () => {
  it('one session per agent per local day', () => {
    const ts = new Date(2026, 6, 22, 9, 30).getTime();
    expect(dayKey(ts)).toBe('2026-07-22');
    expect(daySessionId('scout', dayKey(ts))).toBe('resident-scout-2026-07-22');
  });
});

describe('thread round budget', () => {
  const t0 = 1_000_000_000;

  it('first contact lands immediately', () => {
    expect(nextThreadDelivery(undefined, t0)).toEqual({ mode: 'now', urge: 'reply' });
  });

  it('a live thread batches, winds down, and goes pen-pal', () => {
    let state: ThreadState | undefined;
    let now = t0;
    const modes: string[] = [];
    const urges: Array<string | undefined> = [];
    for (let round = 1; round <= 14; round++) {
      const d = nextThreadDelivery(state, now);
      modes.push(d.mode);
      urges.push('urge' in d ? d.urge : undefined);
      if (d.mode !== 'digest') {
        state = advanceThread(state, now);
        now += 30_000; // replies keep the thread live (< reset window)
      } else {
        now += 30_000;
      }
    }
    // round 1 instant; 2-12 batched; 13+ pen-pal
    expect(modes.slice(0, 13)).toEqual(['now', ...Array.from({ length: 11 }, () => 'delay'), 'digest']);
    expect(urges[6]).toBe('reply'); // round 7 still urges a reply
    expect(urges[7]).toBe('winding_down'); // round 8 stops urging one
    // The last two rounds before the budget stretch their delivery slots.
    const round11 = nextThreadDelivery({ rounds: 10, lastDeliveredAt: t0 }, t0 + 1);
    expect(round11).toEqual({ mode: 'delay', delayMs: THREAD_BASE_DELAY_MS * 2, urge: 'winding_down' });
    const round12 = nextThreadDelivery({ rounds: 11, lastDeliveredAt: t0 }, t0 + 1);
    expect(round12).toEqual({ mode: 'delay', delayMs: THREAD_BASE_DELAY_MS * 4, urge: 'winding_down' });
  });

  it('silence resets the conversation', () => {
    const stale: ThreadState = { rounds: 9, lastDeliveredAt: t0 };
    expect(nextThreadDelivery(stale, t0 + THREAD_RESET_MS)).toEqual({ mode: 'now', urge: 'reply' });
    expect(advanceThread(stale, t0 + THREAD_RESET_MS).rounds).toBe(1);
  });
});

describe('speech client tools', () => {
  it('declares post_channel, dm, and schedule, listing the live channels', () => {
    expect(SPEECH_TOOL_NAMES).toEqual(['post_channel', 'dm', 'schedule', 'remember', 'forget']);
    const tools = speechClientTools(['team', 'deploys']);
    const post = tools.find((t) => t.name === 'post_channel');
    expect(post?.description).toContain('#team, #deploys');
    expect(post?.parameters.required).toEqual(['channel', 'text']);
    expect(tools.find((t) => t.name === 'dm')?.parameters.required).toEqual(['to', 'text']);
    expect(tools.find((t) => t.name === 'schedule')?.parameters.required).toEqual(['minutes', 'note']);
  });

  it('post_channel takes an optional reply_to that threads and wakes participants', () => {
    const post = speechClientTools(['team']).find((t) => t.name === 'post_channel');
    expect(Object.keys(post?.parameters.properties ?? {})).toContain('reply_to');
    expect(post?.parameters.required).not.toContain('reply_to');
    expect(post?.description).toContain("wakes the thread's participants");
  });
});

describe('mentions', () => {
  const scout = { id: 'scout', name: 'Scout' };
  it('matches @id, @name, and bare-name word', () => {
    expect(mentionsAgent('@scout can you look?', scout)).toBe(true);
    expect(mentionsAgent('hey Scout, thoughts?', scout)).toBe(true);
    expect(mentionsAgent('scouting around', scout)).toBe(false);
    expect(mentionsAgent('all quiet today', scout)).toBe(false);
  });
});

describe('wakeup ping', () => {
  it('renders a delta ping with the no-obligation footer', () => {
    const ping = renderWakeupPing({
      nowMs: new Date(2026, 6, 22, 9, 5).getTime(),
      agent: { id: 'scout', name: 'Scout' },
      events: [{ kind: 'dm', from: 'user', text: 'any news?' }],
      digest: [{ id: 7, channel: 'team', from: 'Archivist', text: 'index rebuilt', agoMin: 12 }],
      roster: [
        { id: 'scout', name: 'Scout' },
        { id: 'archivist', name: 'Archivist' },
      ],
    });
    expect(ping).toContain('WHY YOU WOKE');
    expect(ping).toContain('user sent you a direct message');
    expect(ping).toContain('NEW IN #team');
    expect(ping).toContain('[7] Archivist: index rebuilt (12m ago)');
    expect(ping).toContain('post_channel(channel, text, reply_to?)');
    expect(ping).toContain('`archivist`');
    expect(ping).toContain('call no speech tool');
    expect(ping).not.toContain('LONG-HELD MEMORIES');
  });

  it('threads: reply digest rows carry their root; thread_reply events carry context', () => {
    const ping = renderWakeupPing({
      nowMs: Date.now(),
      agent: { id: 'scout', name: 'Scout' },
      events: [
        {
          kind: 'thread_reply',
          from: 'Archivist',
          text: 'rebuilt it, all green',
          channel: 'team',
          messageId: 9,
          rootText: 'can someone rebuild the index?',
        },
      ],
      digest: [
        {
          id: 8,
          channel: 'team',
          from: 'Archivist',
          text: 'on it',
          agoMin: 3,
          replyTo: 5,
          rootExcerpt: 'can someone rebuild the index?',
        },
      ],
      roster: [{ id: 'scout', name: 'Scout' }],
    });
    expect(ping).toContain(
      `Archivist replied in a thread you're in on #team [msg 9]: "rebuilt it, all green" (thread: "can someone rebuild the index?")`
    );
    expect(ping).toContain('[8] Archivist ↳ re [5] "can someone rebuild the index?": on it (3m ago)');
  });
});

describe('memory keys', () => {
  it('slugifies arbitrary input into stable keys', () => {
    expect(memoryKey("User's Deploy Window")).toBe('user-s-deploy-window');
    expect(memoryKey('  deploy-window  ')).toBe('deploy-window');
    expect(memoryKey('!!!')).toBe('');
  });
});

describe('memory tools', () => {
  it('declares remember and forget as keyed client tools', () => {
    expect(SPEECH_TOOL_NAMES).toContain('remember');
    expect(SPEECH_TOOL_NAMES).toContain('forget');
    const tools = speechClientTools(['team']);
    expect(tools.find((t) => t.name === 'remember')?.parameters.required).toEqual(['key', 'text']);
    expect(tools.find((t) => t.name === 'forget')?.parameters.required).toEqual(['key']);
  });
});

describe('reflect prompt', () => {
  it('shows keyed memories and instructs tool-driven curation', () => {
    const prompt = renderReflectPrompt({
      day: '2026-07-22',
      agentName: 'Scout',
      episodic: ['event dm from user'],
      durable: [{ key: 'deploy-window', text: 'ships on Fridays' }],
    });
    expect(prompt).toContain('[deploy-window] ships on Fridays');
    expect(prompt).toContain('remember(key, text)');
    expect(prompt).toContain('forget(key)');
    expect(prompt).not.toContain('fenced');
  });
});

describe('identity instructions render', () => {
  it('carries persona, teammates, memories, and the conduct rules', () => {
    const md = renderIdentityInstructions(
      { id: 'scout', name: 'Scout', role: 'research', personaText: 'You are curious and terse.' },
      [{ key: 'report-style', text: 'the user dislikes long reports', at: 1 }],
      [
        { id: 'scout', name: 'Scout', role: 'research' },
        { id: 'archivist', name: 'Archivist', role: 'docs' },
      ]
    );
    expect(md).toContain('# Scout — research');
    expect(md).toContain('You are curious and terse.');
    expect(md).toContain('Archivist (`@archivist`) — docs');
    expect(md).toContain('[report-style] the user dislikes long reports');
    expect(md).toContain('post_channel(channel, text, reply_to?)');
    expect(md).toContain('home directory'); // unassigned: home IS the workspace
  });

  it('describes the project scope and home mount when projects are set', () => {
    const md = renderIdentityInstructions(
      { id: 'scout', name: 'Scout', role: 'research', personaText: '' },
      [],
      [{ id: 'scout', name: 'Scout', role: 'research' }],
      {
        projects: [
          { label: 'Launcher', mountNames: ['launcher'] },
          { label: 'Notes', mountNames: [] },
        ],
        homeMount: 'home',
      }
    );
    expect(md).toContain('responsible for these projects');
    expect(md).toContain('**Launcher** — `launcher/`');
    expect(md).toContain('**Notes** — no mounted sources');
    expect(md).toContain('`home/` mount');
    expect(md).not.toContain('home directory');
  });
});

describe('digest cursors', () => {
  const log: ResidentChannelMessage[] = [
    { id: 1, channel: 'team', from: 'user', text: 'old', at: 0 },
    { id: 2, channel: 'team', from: 'scout', text: 'my own post', at: 0 },
    { id: 3, channel: 'team', from: 'archivist', fromName: 'Archivist', text: 'indexed', at: 0 },
    { id: 4, channel: 'dm:archivist:user', from: 'user', text: 'private to archivist', at: 0 },
    { id: 5, channel: 'dm:scout:user', from: 'user', text: 'for scout', at: 0 },
  ];

  it('returns unread visible rows and advances past everything', () => {
    const { rows, nextCursor, dropped } = unreadRowsFor(log, 'scout', 1, 60_000, ['team']);
    expect(nextCursor).toBe(5);
    expect(dropped).toBe(0);
    expect(rows).toEqual([
      { id: 3, channel: 'team', from: 'Archivist', text: 'indexed', agoMin: 1 },
      { id: 5, channel: 'dm:scout:user', from: 'user', text: 'for scout', agoMin: 1 },
    ]);
  });

  it('reply rows carry their thread root — with an excerpt even when the root predates the cursor', () => {
    const threaded: ResidentChannelMessage[] = [
      { id: 1, channel: 'team', from: 'user', text: 'can someone rebuild the index?', at: 0 },
      { id: 2, channel: 'team', from: 'archivist', fromName: 'Archivist', text: 'on it', at: 0, replyTo: 1 },
      { id: 3, channel: 'team', from: 'archivist', fromName: 'Archivist', text: 'orphan reply', at: 0, replyTo: 99 },
    ];
    const { rows } = unreadRowsFor(threaded, 'scout', 1, 0, ['team']);
    expect(rows[0]).toEqual({
      id: 2,
      channel: 'team',
      from: 'Archivist',
      text: 'on it',
      agoMin: 0,
      replyTo: 1,
      rootExcerpt: 'can someone rebuild the index?',
    });
    // A pruned root keeps the thread anchor but has no excerpt to offer.
    expect(rows[1]).toEqual({
      id: 3,
      channel: 'team',
      from: 'Archivist',
      text: 'orphan reply',
      agoMin: 0,
      replyTo: 99,
    });
  });

  it('caps rows per channel at the newest and reports the drop', () => {
    const big: ResidentChannelMessage[] = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      channel: 'team',
      from: 'archivist',
      text: `msg ${i + 1}`,
      at: 0,
    }));
    const { rows, dropped } = unreadRowsFor(big, 'scout', 0, 0, ['team']);
    expect(rows).toHaveLength(MAX_DIGEST_ROWS_PER_CHANNEL);
    expect(rows[0]?.text).toBe('msg 5'); // oldest four dropped, order kept
    expect(rows.at(-1)?.text).toBe('msg 12');
    expect(dropped).toBe(4);
  });

  it('membership scopes visibility — non-member channels never surface', () => {
    const mixed: ResidentChannelMessage[] = [
      { id: 1, channel: 'team', from: 'user', text: 'hello all', at: 0 },
      { id: 2, channel: 'deploys', from: 'user', text: 'ship it', at: 0 },
      { id: 3, channel: 'research', from: 'archivist', text: 'found it', at: 0 },
    ];
    const { rows, nextCursor } = unreadRowsFor(mixed, 'scout', 0, 0, ['team', 'deploys']);
    expect(rows.map((r) => r.channel)).toEqual(['team', 'deploys']);
    expect(nextCursor).toBe(3); // cursor passes non-member rows for good
  });

  it('memberChannelIds: team always; absent member list = open', () => {
    const defs = [{ id: 'deploys', members: ['scout'] }, { id: 'research', members: ['archivist'] }, { id: 'random' }];
    expect(memberChannelIds(defs, 'scout')).toEqual(['team', 'deploys', 'random']);
    expect(memberChannelIds(defs, 'archivist')).toEqual(['team', 'research', 'random']);
  });
});

describe('ping extras', () => {
  const base = {
    nowMs: Date.now(),
    agent: { id: 'scout', name: 'Scout' },
    events: [{ kind: 'catch_up' } as const],
    digest: [],
    roster: [{ id: 'scout', name: 'Scout' }],
    firstOfDay: false,
  };

  it('reports omitted rows and delivers notices', () => {
    const ping = renderWakeupPing({ ...base, droppedRows: 4, notices: ['at most 3 messages per turn'] });
    expect(ping).toContain('4 earlier unread messages omitted');
    expect(ping).toContain('## NOTICES');
    expect(ping).toContain('at most 3 messages per turn');
    expect(ping).toContain('unread messages have been waiting');
  });

  it('a late morning beat explains itself; an on-time one stays plain', () => {
    const late = renderWakeupPing({
      ...base,
      events: [
        {
          kind: 'day_start',
          detail:
            'a new working day begins — late start: your 8:00 morning beat waited for the app to open (it is now 11:42); plan for the shortened day',
        },
      ],
    });
    expect(late).toContain('late start: your 8:00 morning beat');
    expect(late).toContain('(it is now 11:42)');
    const onTime = renderWakeupPing({ ...base, events: [{ kind: 'day_start' }] });
    expect(onTime).toContain('a new working day begins');
    expect(onTime).not.toContain('late start');
  });

  it('renders upcoming reminders and the alarm event line', () => {
    const ping = renderWakeupPing({
      ...base,
      events: [{ kind: 'scheduled', text: 'check the CI run' }],
      appointments: ['14:30 (2026-07-23) — nudge scout'],
    });
    expect(ping).toContain('you told yourself: "check the CI run"');
    expect(ping).toContain('## YOUR UPCOMING REMINDERS');
    expect(ping).toContain('14:30 (2026-07-23) — nudge scout');
  });
});
