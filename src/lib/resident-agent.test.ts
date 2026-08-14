import { describe, expect, it } from 'vitest';

import {
  advanceThread,
  channelAudienceIds,
  dayKey,
  daySessionId,
  dmChannelId,
  dmParticipants,
  humanHandle,
  isDirectedAtUser,
  isHumanGradeParticipant,
  isHumanParticipant,
  isWakeNow,
  knownHumansFromLog,
  MAX_DIGEST_ROWS_PER_CHANNEL,
  memberChannelIds,
  MORNING_BEAT_FRESH_MS,
  morningBeatReady,
  memoryKey,
  mentionsAgent,
  nextThreadDelivery,
  participantKind,
  renderIdentityInstructions,
  renderReflectPrompt,
  renderWakeupPing,
  rootAuthors,
  SPEECH_TOOL_NAMES,
  speechClientTools,
  SYSTEM_CHANNEL,
  TEAM_CHANNEL,
  THREAD_BASE_DELAY_MS,
  THREAD_RESET_MS,
  type ThreadState,
  unreadRowsFor,
  USER_PARTICIPANT,
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

describe('channel audience', () => {
  const roster = ['scout', 'rex', 'ada'];
  const defs = [
    { id: 'deploy-log', members: ['scout'], createdAt: 0 },
    { id: 'open-room', createdAt: 0 },
  ];

  it('team is all-hands and an unscoped channel is open to everyone', () => {
    expect(channelAudienceIds(TEAM_CHANNEL, defs, roster)).toEqual(roster);
    expect(channelAudienceIds('open-room', defs, roster)).toEqual(roster);
  });

  it('a scoped channel reaches only its members', () => {
    expect(channelAudienceIds('deploy-log', defs, roster)).toEqual(['scout']);
  });

  it('a DM reaches the peer, never the user', () => {
    expect(channelAudienceIds(dmChannelId(USER_PARTICIPANT, 'rex'), defs, roster)).toEqual(['rex']);
    expect(channelAudienceIds(dmChannelId('scout', 'rex'), defs, roster).sort()).toEqual(['rex', 'scout']);
  });

  it('drops members who have left the roster, and has no audience for unknown or system channels', () => {
    expect(channelAudienceIds('deploy-log', defs, ['rex'])).toEqual([]);
    expect(channelAudienceIds('nope', defs, roster)).toEqual([]);
    expect(channelAudienceIds(SYSTEM_CHANNEL, defs, roster)).toEqual([]);
  });
});

describe('participant grammar', () => {
  it('classifies every stored from-id form', () => {
    expect(participantKind('user')).toBe('human');
    expect(participantKind('human:alice')).toBe('human');
    expect(participantKind('ext:slack:U7')).toBe('external');
    expect(participantKind('system')).toBe('system');
    // Bare roster ids (legacy slugs and opaque res_* ids) stay agents.
    expect(participantKind('scout')).toBe('agent');
    expect(participantKind('res_abc123')).toBe('agent');
  });

  it('human vs human-grade: bridged users count as people for wake purposes', () => {
    expect(isHumanParticipant('user')).toBe(true);
    expect(isHumanParticipant('human:alice')).toBe(true);
    expect(isHumanParticipant('ext:slack:U7')).toBe(false);
    expect(isHumanGradeParticipant('ext:slack:U7')).toBe(true);
    expect(isHumanGradeParticipant('scout')).toBe(false);
  });

  it('DM ids round-trip namespaced participants and keep legacy pairs verbatim', () => {
    // Legacy vocabulary (colon-free): the historical encoding, unchanged.
    expect(dmChannelId('user', 'scout')).toBe('dm:scout:user');
    expect(dmParticipants('dm:scout:user')).toEqual(['scout', 'user']);
    // Namespaced participants switch to the `~` pair separator.
    const personal = dmChannelId('human:alice', 'res_1');
    expect(personal).toBe('dm:human:alice~res_1');
    expect(dmParticipants(personal)).toEqual(['human:alice', 'res_1']);
    const bridged = dmChannelId('ext:slack:U7', 'res_1');
    expect(dmParticipants(bridged)).toEqual(['ext:slack:U7', 'res_1']);
    // Order-insensitive either way.
    expect(dmChannelId('res_1', 'human:alice')).toBe(personal);
  });

  it('humanHandle derives from the display name, else the id tail', () => {
    expect(humanHandle('human:abc123', 'Alice Vimes')).toBe('alice-vimes');
    expect(humanHandle('human:abc123')).toBe('abc123');
    expect(humanHandle('ext:slack:U7')).toBe('u7');
  });

  it('knownHumansFromLog collects named people with their latest name, never the collective user or agents', () => {
    const humans = knownHumansFromLog([
      { from: 'user' },
      { from: 'scout', fromName: 'Scout' },
      { from: 'human:alice', fromName: 'Alice' },
      { from: 'human:alice', fromName: 'Alice V.' },
      { from: 'ext:slack:U7', fromName: 'Sam' },
    ]);
    expect([...humans.entries()]).toEqual([
      ['human:alice', 'Alice V.'],
      ['ext:slack:U7', 'Sam'],
    ]);
  });
});

describe('morning beat timing (quiet-start)', () => {
  const at = (hour: number, minute: number): number => {
    const d = new Date(2026, 7, 12); // local-time day; the rule is local-clock
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };

  it('fires when the hour comes due while the app is running', () => {
    // Booted 7:00, hour 8, tick at 8:03 → inside the freshness window.
    expect(morningBeatReady(8, at(8, 3), at(7, 0))).toBe(true);
  });

  it('never fires before the hour', () => {
    expect(morningBeatReady(8, at(7, 59), at(7, 0))).toBe(false);
  });

  it('skips an hour that passed while the app was closed — opening the app wakes nobody', () => {
    // Booted 11:47, hour 8 → the 8:00 due moment predates boot.
    expect(morningBeatReady(8, at(11, 47), at(11, 47))).toBe(false);
  });

  it('skips an hour missed while the machine slept (no tick landed in the window)', () => {
    // Booted 7:00, asleep 7:50→11:47 — the first tick after resume is far
    // past the freshness window, so the beat is skipped, not delivered late.
    expect(morningBeatReady(8, at(11, 47), at(7, 0))).toBe(false);
  });

  it('the freshness window outlives the 5-minute day tick', () => {
    expect(MORNING_BEAT_FRESH_MS).toBeGreaterThan(5 * 60_000);
    expect(morningBeatReady(8, at(8, 0) + MORNING_BEAT_FRESH_MS, at(7, 0))).toBe(true);
    expect(morningBeatReady(8, at(8, 0) + MORNING_BEAT_FRESH_MS + 1, at(7, 0))).toBe(false);
  });
});

describe('directed traffic', () => {
  const log: ResidentChannelMessage[] = [
    { id: 1, channel: 'team', from: USER_PARTICIPANT, text: 'question?', at: 0 },
    { id: 2, channel: 'team', from: 'scout', text: 'answer', at: 0, replyTo: 1 },
    { id: 3, channel: 'team', from: 'scout', text: 'ambient root', at: 0 },
    { id: 4, channel: 'team', from: 'rex', text: 'ambient reply', at: 0, replyTo: 3 },
    { id: 5, channel: dmChannelId(USER_PARTICIPANT, 'rex'), from: 'rex', text: 'dm', at: 0 },
    { id: 6, channel: dmChannelId('scout', 'rex'), from: 'rex', text: 'their dm', at: 0 },
    { id: 7, channel: SYSTEM_CHANNEL, from: 'system', text: 'declined an approval', at: 0 },
  ];
  const authors = rootAuthors(log);
  const directed = (id: number): boolean => {
    const msg = log.find((m) => m.id === id);
    return msg !== undefined && isDirectedAtUser(msg, (rootId) => authors.get(rootId));
  };

  it('counts replies under a thread the user rooted', () => {
    expect(directed(2)).toBe(true);
  });

  it('does not count ambient agent traffic — including replies between agents', () => {
    expect(directed(3)).toBe(false);
    expect(directed(4)).toBe(false);
  });

  it("counts the user's own DMs but not threads between agents", () => {
    expect(directed(5)).toBe(true);
    expect(directed(6)).toBe(false);
  });

  it('counts system incidents — the attention channel exists to be noticed', () => {
    expect(directed(7)).toBe(true);
  });

  it('scopes personal DM threads to their named participant (viewer-aware)', () => {
    const personal = { channel: dmChannelId('human:alice', 'scout'), from: 'scout' };
    // Directed at Alice, not at other viewers; the collective thread stays
    // directed at everyone.
    expect(isDirectedAtUser(personal, () => undefined, 'human:alice')).toBe(true);
    expect(isDirectedAtUser(personal, () => undefined, 'human:bob')).toBe(false);
    expect(isDirectedAtUser(personal, () => undefined)).toBe(false);
    const collective = { channel: dmChannelId(USER_PARTICIPANT, 'scout'), from: 'scout' };
    expect(isDirectedAtUser(collective, () => undefined, 'human:bob')).toBe(true);
  });

  it('treats named humans like the collective user (v1 collective view)', () => {
    const authorsOf = rootAuthors([
      { id: 10, from: 'human:alice' },
      { id: 11, from: 'scout' },
    ]);
    const lookup = (rootId: number): string | undefined => authorsOf.get(rootId);
    // A named human's own post is never directed AT the humans…
    expect(isDirectedAtUser({ channel: 'team', from: 'human:alice' }, lookup)).toBe(false);
    // …but an agent answering a thread a named human rooted is.
    expect(isDirectedAtUser({ channel: 'team', from: 'scout', replyTo: 10 }, lookup)).toBe(true);
    expect(isDirectedAtUser({ channel: 'team', from: 'scout', replyTo: 11 }, lookup)).toBe(false);
  });

  it("never counts the user's own posts", () => {
    expect(directed(1)).toBe(false);
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
      // Human rows with no stored name render as "the user" (chat-v1 stores
      // no viewer-relative names; the ping names the collective human).
      { id: 5, channel: 'dm:scout:user', from: 'the user', text: 'for scout', agoMin: 1 },
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

  it('a day_start renders its detail when present, else the plain line', () => {
    const detailed = renderWakeupPing({
      ...base,
      events: [{ kind: 'day_start', detail: 'a new working day begins — the deploy freeze lifts today' }],
    });
    expect(detailed).toContain('the deploy freeze lifts today');
    const plain = renderWakeupPing({ ...base, events: [{ kind: 'day_start' }] });
    expect(plain).toContain('a new working day begins');
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
