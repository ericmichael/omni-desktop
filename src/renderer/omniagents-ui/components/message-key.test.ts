import { describe, expect, it } from 'vitest';

import type { CanonicalItemEnvelope, MessageItem } from '@/shared/chat-types';

import type { ActivityGroupData } from './activity-group';
import { messageKey } from './message-key';

function canonical(item_id: string): CanonicalItemEnvelope {
  return {
    item_id,
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    seq: 1,
    kind: 'message',
    status: 'completed',
    revision: 1,
    created_at: 0,
    updated_at: 0,
    content: {},
    source_ref: {},
  };
}

describe('messageKey', () => {
  it('prefers the canonical id — the one identity a reload agrees on', () => {
    const item: MessageItem = { type: 'chat', role: 'assistant', content: 'hi', canonical: canonical('itm_1') };
    expect(messageKey(item, 0)).toBe('canonical:itm_1');
    expect(messageKey(item, 7)).toBe('canonical:itm_1');
  });

  it('keys a live voice turn by its realtime item id', () => {
    const item: MessageItem = { type: 'chat', role: 'user', content: 'hello', item_id: 'item_abc' };
    expect(messageKey(item, 0)).toBe('chat:item_abc');
    // Same item, different position after the transcript re-sorts.
    expect(messageKey(item, 3)).toBe('chat:item_abc');
  });

  it('keys tools by call_id so a card keeps its own expansion', () => {
    const item: MessageItem = { type: 'tool', tool: 'bash', call_id: 'call_1', status: 'called' };
    expect(messageKey(item, 0)).toBe('tool:call_1');
    expect(messageKey({ ...item, runId: 'first' }, 0)).not.toBe(messageKey({ ...item, runId: 'second' }, 0));
  });

  it('covers the id-bearing card types', () => {
    expect(messageKey({ type: 'approval', request_id: 'req_1', tool: 'bash' }, 0)).toBe('approval:req_1');
    expect(
      messageKey(
        { type: 'guardian_review', request_id: 'req_1', tool: 'bash', reviewer: 'guardian', outcome: 'allow' },
        0
      )
    ).toBe('guardian:req_1');
    expect(
      messageKey(
        { type: 'workflow_review', task_id: 'task_1', subject: 's', outcome: 'reject', reviewer: 'guardian' },
        0
      )
    ).toBe('workflow:task_1:reject');
    expect(messageKey({ type: 'plan', id: 'plan_1', title: 't', steps: [] }, 0)).toBe('plan:plan_1');
    expect(messageKey({ type: 'artifact', artifact_id: 'art_1', title: 't', content: '' }, 0)).toBe('artifact:art_1');
  });

  it('falls back to position only when the item carries no id at all', () => {
    const live: MessageItem = { type: 'chat', role: 'assistant', content: 'streaming' };
    expect(messageKey(live, 2)).toBe('at:2:chat');
    // The fallback is namespaced so it can never collide with a real id.
    expect(messageKey(live, 2)).not.toBe(messageKey({ ...live, item_id: 'at:2:chat' }, 2));
  });

  it('gives an activity group its first member’s identity', () => {
    const group: ActivityGroupData = {
      type: 'activity_group',
      runId: 'run_1',
      isRunning: true,
      items: [{ type: 'tool', tool: 'bash', call_id: 'call_1', status: 'called' }],
    };
    expect(messageKey(group, 0)).toBe('group:tool:call_1');

    // Appending a second tool to the block must not change its key.
    const grown: ActivityGroupData = {
      ...group,
      items: [...group.items, { type: 'tool', tool: 'grep', call_id: 'call_2', status: 'called' }],
    };
    expect(messageKey(grown, 0)).toBe('group:tool:call_1');
  });

  it('keeps an empty group keyed by its run', () => {
    const group: ActivityGroupData = { type: 'activity_group', runId: 'run_1', isRunning: false, items: [] };
    expect(messageKey(group, 4)).toBe('group:run_1:4');
  });

  it('produces unique keys across a mixed transcript', () => {
    const items: MessageItem[] = [
      { type: 'chat', role: 'user', content: 'a' },
      { type: 'chat', role: 'assistant', content: 'b' },
      { type: 'chat', role: 'assistant', content: 'c', item_id: 'item_1' },
      { type: 'tool', tool: 'bash', call_id: 'call_1', status: 'called' },
      { type: 'approval', request_id: 'req_1', tool: 'bash' },
    ];
    const keys = items.map(messageKey);
    expect(new Set(keys).size).toBe(items.length);
  });
});
