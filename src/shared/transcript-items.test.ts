import { describe, expect, it } from 'vitest';

import type { MessageItem, ToolItem } from '@/shared/chat-types';
import { appendAssistantMessage, applyToolResult, upsertToolCall } from '@/shared/transcript-items';

const tools = (items: MessageItem[]): ToolItem[] => items.filter((it): it is ToolItem => it.type === 'tool');

it('keeps repeated provider call IDs in separate runs and never reopens a settled call', () => {
  const called = { call_id: 'same', tool: 'bash', input: '{}' };
  let items = upsertToolCall([], called, 'one');
  items = applyToolResult(items, { ...called, output: 'first' }, 'one');
  expect(upsertToolCall(items, called, 'one')).toBe(items);
  expect(applyToolResult(items, { ...called, output: 'late' }, 'one')).toBe(items);
  items = upsertToolCall(items, called, 'two');
  items = applyToolResult(items, { ...called, output: 'second' }, 'two');
  expect(tools(items).map((item) => [item.runId, item.output])).toEqual([
    ['one', 'first'],
    ['two', 'second'],
  ]);
});

describe('appendAssistantMessage', () => {
  it('appends a run-stamped assistant message', () => {
    const items = appendAssistantMessage([], 'found it in auth.ts', 'run-1');
    expect(items).toEqual([{ type: 'chat', role: 'assistant', content: 'found it in auth.ts', runId: 'run-1' }]);
  });

  it('dedupes on (runId, content) — replay must not double the message', () => {
    const once = appendAssistantMessage([], 'same text', 'run-1');
    const twice = appendAssistantMessage(once, 'same text', 'run-1');
    expect(twice).toBe(once);
  });

  it('keeps identical text from a different run', () => {
    const first = appendAssistantMessage([], 'same text', 'run-1');
    const second = appendAssistantMessage(first, 'same text', 'run-2');
    expect(second).toHaveLength(2);
  });
});

describe('upsertToolCall', () => {
  it('appends a called row stamped with the run', () => {
    const items = upsertToolCall([], { call_id: 'c1', tool: 'read_file', input: '{"path":"a.ts"}' }, 'run-1');
    expect(tools(items)).toEqual([
      {
        type: 'tool',
        tool: 'read_file',
        server_label: undefined,
        tool_label: undefined,
        input: '{"path":"a.ts"}',
        call_id: 'c1',
        status: 'called',
        metadata: undefined,
        runId: 'run-1',
      },
    ]);
  });

  it('upserts by call_id rather than duplicating a rehydrated call', () => {
    const first = upsertToolCall([], { call_id: 'c1', tool: 'read_file', input: 'a' }, 'run-1');
    const second = upsertToolCall(first, { call_id: 'c1', tool: 'read_file', input: 'b' }, 'run-1');
    expect(tools(second)).toHaveLength(1);
    expect(tools(second)[0]!.input).toBe('b');
  });
});

describe('applyToolResult', () => {
  it('settles the matching call in place', () => {
    const called = upsertToolCall([], { call_id: 'c1', tool: 'search', input: 'q' }, 'run-1');
    const settled = applyToolResult(called, { call_id: 'c1', tool: 'search', output: '3 hits' }, 'run-1');
    expect(tools(settled)).toHaveLength(1);
    expect(tools(settled)[0]).toMatchObject({ status: 'result', output: '3 hits', input: 'q' });
  });

  it('renders a result whose call was never seen as its own settled row', () => {
    const settled = applyToolResult([], { call_id: 'c9', tool: 'search', output: 'late' }, 'run-1');
    expect(tools(settled)).toMatchObject([{ call_id: 'c9', status: 'result', output: 'late', runId: 'run-1' }]);
  });
});
