import { beforeEach, describe, expect, it } from 'vitest';

import {
  $subagentTranscriptsBySession,
  publishSubagentEvent,
  publishSubagentsSnapshot,
  type SubagentSummary,
} from './activity-store';

const SESSION = 'parent-sess';

const agentTool = (overrides: Partial<SubagentSummary> = {}): SubagentSummary => ({
  subagent_id: 'call-1',
  kind: 'agent_tool',
  agent: 'explorer',
  status: 'running',
  task: 'how is auth implemented?',
  parent_session_id: SESSION,
  // Agent-tool runs execute inside the parent's turn — no session of their own.
  session_id: '',
  run_id: 'call-1',
  result: null,
  error: null,
  isolation: null,
  started_at: null,
  finished_at: null,
  wall_time_ms: null,
  ...overrides,
});

const transcript = (subagentId: string) => $subagentTranscriptsBySession.get()[SESSION]?.[subagentId] ?? [];

beforeEach(() => {
  $subagentTranscriptsBySession.set({});
  publishSubagentsSnapshot(SESSION, []);
});

describe('publishSubagentEvent', () => {
  it('folds relayed beats into transcript items stamped with the subagent id as run id', () => {
    publishSubagentEvent(SESSION, 'call-1', 'run_started', { run_id: 'call-1', agent: 'explorer' });
    publishSubagentEvent(SESSION, 'call-1', 'tool_called', {
      call_id: 'c1',
      tool: 'search',
      input: '{"query":"login"}',
    });
    publishSubagentEvent(SESSION, 'call-1', 'tool_result', { call_id: 'c1', tool: 'search', output: '3 files' });
    publishSubagentEvent(SESSION, 'call-1', 'message_output', { content: 'auth lives in auth.ts' });

    expect(transcript('call-1')).toEqual([
      {
        type: 'tool',
        tool: 'search',
        server_label: undefined,
        tool_label: undefined,
        input: '{"query":"login"}',
        call_id: 'c1',
        status: 'result',
        output: '3 files',
        metadata: undefined,
        runId: 'call-1',
      },
      { type: 'chat', role: 'assistant', content: 'auth lives in auth.ts', runId: 'call-1' },
    ]);
  });

  it('keeps each subagent’s steps in its own buffer', () => {
    publishSubagentEvent(SESSION, 'call-1', 'tool_called', { call_id: 'a', tool: 'read_file', input: '1' });
    publishSubagentEvent(SESSION, 'call-2', 'tool_called', { call_id: 'b', tool: 'read_file', input: '2' });

    expect(transcript('call-1')).toHaveLength(1);
    expect(transcript('call-2')).toHaveLength(1);
  });

  it('suppresses the tools that paint another surface', () => {
    publishSubagentEvent(SESSION, 'call-1', 'tool_called', { call_id: 'n', tool: 'notify', input: '{}' });
    expect(transcript('call-1')).toHaveLength(0);
  });

  it('ignores lifecycle beats the snapshot already reports', () => {
    publishSubagentEvent(SESSION, 'call-1', 'run_end', { run_id: 'call-1' });
    publishSubagentEvent(SESSION, 'call-1', 'run_status', { status: 'thinking' });
    expect($subagentTranscriptsBySession.get()[SESSION]).toBeUndefined();
  });
});

describe('transcript pruning', () => {
  it('drops buffers for runs the snapshot no longer carries', () => {
    publishSubagentEvent(SESSION, 'call-1', 'tool_called', { call_id: 'a', tool: 'read_file', input: '1' });
    publishSubagentEvent(SESSION, 'call-2', 'tool_called', { call_id: 'b', tool: 'read_file', input: '2' });
    publishSubagentsSnapshot(SESSION, [agentTool({ subagent_id: 'call-2' })]);

    expect(transcript('call-1')).toHaveLength(0);
    expect(transcript('call-2')).toHaveLength(1);
  });

  it('leaves live buffers untouched', () => {
    publishSubagentEvent(SESSION, 'call-1', 'tool_called', { call_id: 'a', tool: 'read_file', input: '1' });
    const before = $subagentTranscriptsBySession.get()[SESSION];
    publishSubagentsSnapshot(SESSION, [agentTool()]);
    expect($subagentTranscriptsBySession.get()[SESSION]).toBe(before);
  });
});
