import { describe, expect, it } from 'vitest';

import { parseSessionHistoryRows, type HistoryRow } from './session-history';

const row = (id: number, msg: unknown, createdAt = '2026-01-01T00:00:00Z'): HistoryRow => ({
  id,
  msg_json: JSON.stringify(msg),
  created_at: createdAt,
});

describe('parseSessionHistoryRows', () => {
  it('skips reasoning blocks', () => {
    const out = parseSessionHistoryRows([row(1, { type: 'reasoning', role: 'assistant' })]);
    expect(out).toEqual([]);
  });

  it('parses user string content', () => {
    const out = parseSessionHistoryRows([row(1, { role: 'user', content: 'hello' })]);
    expect(out).toEqual([{ id: 1, role: 'user', content: 'hello', createdAt: '2026-01-01T00:00:00Z' }]);
  });

  it('stringifies non-string user content', () => {
    const out = parseSessionHistoryRows([row(1, { role: 'user', content: { parts: ['a', 'b'] } })]);
    expect(out[0]!.content).toBe(JSON.stringify({ parts: ['a', 'b'] }));
  });

  it('joins assistant text blocks and skips non-text', () => {
    const out = parseSessionHistoryRows([
      row(1, {
        role: 'assistant',
        type: 'message',
        content: [
          { type: 'text', text: 'line1' },
          { type: 'tool_use', id: 'x' },
          { type: 'text', text: 'line2' },
        ],
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('line1\nline2');
    expect(out[0]!.role).toBe('assistant');
  });

  it('drops assistant message when text block array is empty', () => {
    const out = parseSessionHistoryRows([
      row(1, { role: 'assistant', type: 'message', content: [{ type: 'tool_use' }] }),
    ]);
    expect(out).toEqual([]);
  });

  it('parses function_call as tool_call with name', () => {
    const out = parseSessionHistoryRows([
      row(1, { type: 'function_call', name: 'read_file', arguments: '{"path":"x"}' }),
    ]);
    expect(out[0]).toMatchObject({ role: 'tool_call', toolName: 'read_file', content: '{"path":"x"}' });
  });

  it('falls back to unknown_tool for nameless function_call and stringifies object args', () => {
    const out = parseSessionHistoryRows([row(1, { type: 'function_call', arguments: { path: 'x' } })]);
    expect(out[0]!.toolName).toBe('unknown_tool');
    expect(out[0]!.content).toBe('{"path":"x"}');
  });

  it('parses function_call_output as tool_result', () => {
    const out = parseSessionHistoryRows([row(1, { type: 'function_call_output', output: 'done' })]);
    expect(out[0]).toMatchObject({ role: 'tool_result', content: 'done' });
  });

  it('truncates long user content to 50k', () => {
    const big = 'a'.repeat(60_000);
    const out = parseSessionHistoryRows([row(1, { role: 'user', content: big })]);
    expect(out[0]!.content.length).toBe(50_000);
  });

  it('truncates long tool_call args to 2k', () => {
    const big = 'a'.repeat(3_000);
    const out = parseSessionHistoryRows([row(1, { type: 'function_call', name: 'x', arguments: big })]);
    expect(out[0]!.content.length).toBe(2_000);
  });

  it('truncates long tool_result output to 5k', () => {
    const big = 'a'.repeat(6_000);
    const out = parseSessionHistoryRows([row(1, { type: 'function_call_output', output: big })]);
    expect(out[0]!.content.length).toBe(5_000);
  });

  it('skips unparseable rows and keeps going', () => {
    const out = parseSessionHistoryRows([
      { id: 1, msg_json: 'not json', created_at: '' },
      row(2, { role: 'user', content: 'ok' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(2);
  });
});
