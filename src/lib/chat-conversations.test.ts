import { describe, expect, it } from 'vitest';

import { conversationTitle, pruneConversations, upsertConversation } from '@/lib/chat-conversations';
import type { ChatConversation } from '@/shared/types';

const conv = (sessionId: string, lastActiveAt: number, patch: Partial<ChatConversation> = {}): ChatConversation => ({
  sessionId,
  title: `t-${sessionId}`,
  lastActiveAt,
  ...patch,
});

describe('conversationTitle', () => {
  it('uses the first non-empty line', () => {
    expect(conversationTitle('\n\n  Fix the login bug  \nmore detail')).toBe('Fix the login bug');
  });

  it('truncates long messages with an ellipsis', () => {
    const title = conversationTitle('x'.repeat(100));
    expect(title.length).toBe(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back for empty input (files-only message)', () => {
    expect(conversationTitle('  \n ')).toBe('New chat');
  });
});

describe('upsertConversation', () => {
  it('inserts newest-first by lastActiveAt', () => {
    const list = upsertConversation([conv('a', 10), conv('b', 30)], { sessionId: 'c', lastActiveAt: 20 });
    expect(list.map((c) => c.sessionId)).toEqual(['b', 'c', 'a']);
  });

  it('merges over the existing entry so partial updates keep prior fields', () => {
    const list = upsertConversation([conv('a', 10, { title: 'Plan my week', containerId: 'cont-1' })], {
      sessionId: 'a',
      lastActiveAt: 50,
      profileName: 'devbox',
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      title: 'Plan my week',
      containerId: 'cont-1',
      profileName: 'devbox',
      lastActiveAt: 50,
    });
  });

  it('defaults the title for a brand-new entry without one', () => {
    const list = upsertConversation([], { sessionId: 'a', lastActiveAt: 1 });
    expect(list[0]?.title).toBe('New chat');
  });
});

describe('pruneConversations', () => {
  it('keeps the newest `max` and returns the pruned tail', () => {
    const list = [conv('a', 1), conv('b', 3), conv('c', 2)];
    const { kept, pruned } = pruneConversations(list, 2);
    expect(kept.map((c) => c.sessionId)).toEqual(['b', 'c']);
    expect(pruned.map((c) => c.sessionId)).toEqual(['a']);
  });

  it('is a no-op under the cap', () => {
    const { kept, pruned } = pruneConversations([conv('a', 1)], 50);
    expect(kept).toHaveLength(1);
    expect(pruned).toHaveLength(0);
  });
});
