import { describe, expect,it } from 'vitest';

import {rehydrateHistory } from './rehydrate-history';

describe('rehydrateHistory', () => {
  // -------------------------------------------------------------------
  // Basic message types
  // -------------------------------------------------------------------

  it('parses a simple user message (role only, string content)', () => {
    const history = [{ role: 'user', content: 'hello' }];
    const items = rehydrateHistory(history);
    expect(items).toEqual([{ type: 'chat', role: 'user', content: 'hello', timestamp: undefined, attachments: [] }]);
  });

  it('parses an assistant message with output_text parts', () => {
    const history = [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello world', annotations: [] }],
      },
    ];
    const items = rehydrateHistory(history);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'chat', role: 'assistant', content: 'Hello world' });
  });

  it('joins multiple output_text parts with newline', () => {
    const history = [
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Part 1' },
          { type: 'output_text', text: 'Part 2' },
        ],
      },
    ];
    const items = rehydrateHistory(history);
    expect(items[0]).toMatchObject({ type: 'chat', content: 'Part 1\nPart 2' });
  });

  // -------------------------------------------------------------------
  // Tool calls and outputs
  // -------------------------------------------------------------------

  it('parses a function_call + function_call_output pair', () => {
    const history = [
      { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"/tmp"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'file contents' },
    ];
    const items = rehydrateHistory(history);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'tool',
      tool: 'read_file',
      call_id: 'c1',
      input: '{"path":"/tmp"}',
      output: 'file contents',
      status: 'result',
    });
  });

  it('handles orphaned function_call_output (no matching call)', () => {
    const history = [{ type: 'function_call_output', call_id: 'orphan', output: 'result' }];
    const items = rehydrateHistory(history);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'tool', call_id: 'orphan', status: 'result', output: 'result' });
  });

  it('handles function_call with object arguments', () => {
    const history = [{ type: 'function_call', call_id: 'c2', name: 'tool', arguments: { x: 1 } }];
    const items = rehydrateHistory(history);
    expect(items[0]).toMatchObject({ type: 'tool', input: '{"x":1}' });
  });

  // -------------------------------------------------------------------
  // Full conversation round-trip
  // -------------------------------------------------------------------

  it('parses a full conversation: user → assistant → tool_call → tool_output → assistant', () => {
    const history = [
      { role: 'user', content: 'read the file' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: "I'll read it." }],
      },
      { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"x"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'contents' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Here are the contents.' }],
      },
    ];
    const items = rehydrateHistory(history);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ type: 'chat', role: 'user', content: 'read the file' });
    expect(items[1]).toMatchObject({ type: 'chat', role: 'assistant', content: "I'll read it." });
    expect(items[2]).toMatchObject({ type: 'tool', tool: 'read_file', status: 'result' });
    expect(items[3]).toMatchObject({ type: 'chat', role: 'assistant', content: 'Here are the contents.' });
  });

  // -------------------------------------------------------------------
  // Reasoning items — should be silently skipped
  // -------------------------------------------------------------------

  it('skips reasoning items', () => {
    const history = [
      { type: 'reasoning', id: 'rs_1', content: [{ type: 'thinking', text: 'hmm' }] },
      { role: 'user', content: 'hello' },
    ];
    const items = rehydrateHistory(history);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'chat', role: 'user' });
  });

  // -------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------

  it('returns empty array for empty history', () => {
    expect(rehydrateHistory([])).toEqual([]);
  });

  it('handles assistant message with plain string content', () => {
    // Some models / compaction may produce this
    const history = [{ role: 'assistant', content: 'plain text' }];
    const items = rehydrateHistory(history);
    expect(items[0]).toMatchObject({ type: 'chat', role: 'assistant', content: 'plain text' });
  });

  it('handles user message with input_text parts and image attachment', () => {
    const history = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look at this' },
          { type: 'input_image', image_url: 'data:image/png;base64,...', filename: 'screenshot.png' },
        ],
      },
    ];
    const items = rehydrateHistory(history);
    expect(items[0]).toMatchObject({
      type: 'chat',
      role: 'user',
      content: 'look at this',
      attachments: [{ type: 'image', url: 'data:image/png;base64,...', filename: 'screenshot.png' }],
    });
  });

  it('handles parallel tool calls', () => {
    const history = [
      { type: 'function_call', call_id: 'c1', name: 'tool_a', arguments: '{}' },
      { type: 'function_call', call_id: 'c2', name: 'tool_b', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'a_result' },
      { type: 'function_call_output', call_id: 'c2', output: 'b_result' },
    ];
    const items = rehydrateHistory(history);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ tool: 'tool_a', call_id: 'c1', status: 'result', output: 'a_result' });
    expect(items[1]).toMatchObject({ tool: 'tool_b', call_id: 'c2', status: 'result', output: 'b_result' });
  });

  it('preserves metadata on tool results', () => {
    const history = [
      { type: 'function_call', call_id: 'c1', name: 'tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok', metadata: { url: 'http://example.com' } },
    ];
    const items = rehydrateHistory(history);
    expect((items[0] as any).metadata).toEqual({ url: 'http://example.com' });
  });
});
