import { describe, expect, it } from 'vitest';

import {
  automationFireDetail,
  describeTrigger,
  matchesChannelMessage,
  matchesPrEvent,
  MESSAGE_TRIGGER_COOLDOWN_MS,
  messageCooldownActive,
} from './automations';

describe('matchesPrEvent', () => {
  const ev = { kind: 'ci_failed' as const, repo: 'acme/launcher' };

  it('matches with no filters', () => {
    expect(matchesPrEvent({ kind: 'pr_event' }, ev)).toBe(true);
    expect(matchesPrEvent({ kind: 'pr_event', events: [] }, ev)).toBe(true);
  });

  it('filters by event kind', () => {
    expect(matchesPrEvent({ kind: 'pr_event', events: ['ci_failed', 'merged'] }, ev)).toBe(true);
    expect(matchesPrEvent({ kind: 'pr_event', events: ['approved'] }, ev)).toBe(false);
  });

  it('filters by repo substring, case-insensitive', () => {
    expect(matchesPrEvent({ kind: 'pr_event', repo: 'Launcher' }, ev)).toBe(true);
    expect(matchesPrEvent({ kind: 'pr_event', repo: 'acme/' }, ev)).toBe(true);
    expect(matchesPrEvent({ kind: 'pr_event', repo: 'other-repo' }, ev)).toBe(false);
    // Blank filter = no filter.
    expect(matchesPrEvent({ kind: 'pr_event', repo: '  ' }, ev)).toBe(true);
  });
});

describe('matchesChannelMessage', () => {
  const trigger = { kind: 'channel_message' as const, channel: 'team' };

  it('matches human posts in the trigger channel only', () => {
    expect(matchesChannelMessage(trigger, { channel: 'team', from: 'user', text: 'hi' })).toBe(true);
    expect(matchesChannelMessage(trigger, { channel: 'team', from: 'human:alice', text: 'hi' })).toBe(true);
    expect(matchesChannelMessage(trigger, { channel: 'other', from: 'user', text: 'hi' })).toBe(false);
  });

  it('never fires on agent or system posts (the loop guard)', () => {
    expect(matchesChannelMessage(trigger, { channel: 'team', from: 'res_1', text: 'hi' })).toBe(false);
    expect(matchesChannelMessage(trigger, { channel: 'team', from: 'system', text: 'hi' })).toBe(false);
  });

  it('applies the contains filter case-insensitively', () => {
    const t = { ...trigger, contains: 'Deploy' };
    expect(matchesChannelMessage(t, { channel: 'team', from: 'user', text: 'please deploy now' })).toBe(true);
    expect(matchesChannelMessage(t, { channel: 'team', from: 'user', text: 'nothing to see' })).toBe(false);
  });
});

describe('messageCooldownActive', () => {
  it('gates within the window, clears after', () => {
    expect(messageCooldownActive(undefined, 1000)).toBe(false);
    expect(messageCooldownActive(1000, 1000 + MESSAGE_TRIGGER_COOLDOWN_MS - 1)).toBe(true);
    expect(messageCooldownActive(1000, 1000 + MESSAGE_TRIGGER_COOLDOWN_MS)).toBe(false);
  });
});

describe('formatting', () => {
  it('describes each trigger shape', () => {
    expect(describeTrigger({ kind: 'pr_event', events: ['ci_failed'], repo: 'acme/launcher' })).toBe(
      'on ci_failed in acme/launcher'
    );
    expect(describeTrigger({ kind: 'pr_event' })).toBe('on any PR event');
    expect(describeTrigger({ kind: 'channel_message', channel: 'team', contains: 'deploy' })).toBe(
      'on a message in #team containing "deploy"'
    );
    expect(describeTrigger({ kind: 'schedule', schedule: { kind: 'daily', time: '09:00', weekdaysOnly: true } })).toBe(
      'daily at 09:00 (weekdays)'
    );
    expect(describeTrigger({ kind: 'schedule', schedule: { kind: 'interval', everyMinutes: 30 } })).toBe('every 30m');
  });

  it('composes the wakeup detail from cause + standing instruction', () => {
    expect(
      automationFireDetail({ name: 'Fix CI', instruction: 'address the failure and push' }, 'CI is failing on PR #142')
    ).toBe(
      'automation "Fix CI" fired (CI is failing on PR #142) — your standing instruction: address the failure and push'
    );
  });
});
