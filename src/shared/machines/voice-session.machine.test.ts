import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';

import { voiceActive, voiceOrbState, voicePhase, voiceSessionMachine } from './voice-session.machine';

function startActor() {
  const actor = createActor(voiceSessionMachine);
  actor.start();
  return actor;
}

function openLive(actor: ReturnType<typeof startActor>, sessionId = 'sess-1') {
  actor.send({ type: 'OPEN', sessionId });
  actor.send({ type: 'CONNECTED' });
  actor.send({ type: 'SESSION_STARTED', sessionId, runId: 'run-1', at: 1000 });
}

describe('voice-session machine', () => {
  it('walks the open lifecycle to attending', () => {
    const actor = startActor();
    expect(voicePhase(actor.getSnapshot())).toBe('closed');
    expect(voiceActive(actor.getSnapshot())).toBe(false);

    actor.send({ type: 'OPEN', sessionId: 'sess-1' });
    expect(voicePhase(actor.getSnapshot())).toBe('connecting');
    actor.send({ type: 'CONNECTED' });
    expect(voicePhase(actor.getSnapshot())).toBe('starting');
    actor.send({ type: 'SESSION_STARTED', sessionId: 'sess-real', runId: 'run-1', at: 123 });

    const snap = actor.getSnapshot();
    expect(voicePhase(snap)).toBe('attending');
    expect(snap.context.sessionId).toBe('sess-real');
    expect(snap.context.runId).toBe('run-1');
    expect(snap.context.startedAt).toBe(123);
    expect(voiceActive(snap)).toBe(true);
  });

  it('drives responding → speaking → attending from playback reality', () => {
    const actor = startActor();
    openLive(actor);

    actor.send({ type: 'RESPONSE_START' });
    expect(voicePhase(actor.getSnapshot())).toBe('responding');
    actor.send({ type: 'PLAYBACK_ACTIVE' });
    expect(voicePhase(actor.getSnapshot())).toBe('speaking');
    // Turn end while audio still draining does not exit speaking...
    actor.send({ type: 'TURN_ENDED' });
    expect(voicePhase(actor.getSnapshot())).toBe('speaking');
    // ...actual playback end does.
    actor.send({ type: 'PLAYBACK_IDLE' });
    expect(voicePhase(actor.getSnapshot())).toBe('attending');
  });

  it('a no-audio turn exits responding on TURN_ENDED (no stuck thinking)', () => {
    const actor = startActor();
    openLive(actor);
    actor.send({ type: 'TURN_STARTED' });
    expect(voicePhase(actor.getSnapshot())).toBe('responding');
    actor.send({ type: 'TURN_ENDED' });
    expect(voicePhase(actor.getSnapshot())).toBe('attending');
  });

  it('interrupt and server-side interruption both exit speaking', () => {
    const actor = startActor();
    openLive(actor);
    actor.send({ type: 'RESPONSE_START' });
    actor.send({ type: 'PLAYBACK_ACTIVE' });
    actor.send({ type: 'INTERRUPT' });
    expect(voicePhase(actor.getSnapshot())).toBe('attending');

    actor.send({ type: 'PLAYBACK_ACTIVE' });
    actor.send({ type: 'AUDIO_INTERRUPTED' });
    expect(voicePhase(actor.getSnapshot())).toBe('attending');
  });

  it('accumulates assistant deltas per item and lets the final replace them', () => {
    const actor = startActor();
    openLive(actor);

    actor.send({ type: 'TRANSCRIPT_DELTA', itemId: 'a', delta: 'Hel' });
    actor.send({ type: 'TRANSCRIPT_DELTA', itemId: 'a', delta: 'lo' });
    actor.send({ type: 'TRANSCRIPT_DELTA', itemId: 'b', delta: 'Next' });

    let items = actor.getSnapshot().context.items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: 'chat', role: 'assistant', content: 'Hello' });
    expect(items[1]).toMatchObject({ type: 'chat', role: 'assistant', content: 'Next' });

    actor.send({ type: 'TRANSCRIPT_FINAL', itemId: 'a', role: 'assistant', text: 'Hello there.' });
    items = actor.getSnapshot().context.items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ content: 'Hello there.' });
  });

  it('user finals append as user messages', () => {
    const actor = startActor();
    openLive(actor);
    actor.send({ type: 'TRANSCRIPT_FINAL', itemId: 'u1', role: 'user', text: 'What time is it?' });
    const items = actor.getSnapshot().context.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'chat', role: 'user', content: 'What time is it?' });
  });

  it('tracks tool activity as ToolItems and the activeTool status', () => {
    const actor = startActor();
    openLive(actor);

    actor.send({ type: 'TOOL_START', callId: 'c1', tool: 'grep_files', input: '{"q":"x"}' });
    let snap = actor.getSnapshot();
    expect(snap.context.activeTool).toBe('grep_files');
    expect(snap.context.items[0]).toMatchObject({ type: 'tool', tool: 'grep_files', status: 'called' });

    actor.send({ type: 'TOOL_END', callId: 'c1', tool: 'grep_files', output: '3 matches' });
    snap = actor.getSnapshot();
    expect(snap.context.activeTool).toBeUndefined();
    expect(snap.context.items[0]).toMatchObject({ type: 'tool', status: 'result', output: '3 matches' });
    expect(snap.context.items).toHaveLength(1);
  });

  it('matches a tool end without call_id to the last running tool', () => {
    const actor = startActor();
    openLive(actor);
    actor.send({ type: 'TOOL_START', callId: 'c1', tool: 'bash' });
    actor.send({ type: 'TOOL_END', callId: '', tool: 'bash', output: 'done' });
    const items = actor.getSnapshot().context.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'tool', status: 'result', output: 'done' });
  });

  it('SEND_TEXT appends a user item immediately', () => {
    const actor = startActor();
    openLive(actor);
    actor.send({ type: 'SEND_TEXT', text: '  deploy it  ' });
    expect(actor.getSnapshot().context.items[0]).toMatchObject({
      type: 'chat',
      role: 'user',
      content: 'deploy it',
    });
  });

  it('close path clears everything', () => {
    const actor = startActor();
    openLive(actor);
    actor.send({ type: 'TRANSCRIPT_FINAL', itemId: 'u1', role: 'user', text: 'hi' });
    actor.send({ type: 'CLOSE' });
    expect(voicePhase(actor.getSnapshot())).toBe('stopping');
    actor.send({ type: 'STOPPED' });
    const snap = actor.getSnapshot();
    expect(voicePhase(snap)).toBe('closed');
    expect(snap.context.items).toEqual([]);
    expect(snap.context.sessionId).toBeUndefined();
  });

  it('connection loss lands in error and OPEN retries', () => {
    const actor = startActor();
    openLive(actor);
    actor.send({ type: 'DISCONNECTED', message: 'socket died' });
    let snap = actor.getSnapshot();
    expect(voicePhase(snap)).toBe('error');
    expect(snap.context.error).toBe('socket died');
    expect(voiceActive(snap)).toBe(true); // dock stays up to show the error

    actor.send({ type: 'OPEN', sessionId: 'sess-1' });
    snap = actor.getSnapshot();
    expect(voicePhase(snap)).toBe('connecting');
    expect(snap.context.error).toBeUndefined();
  });

  it('server errors are recorded without killing the live session', () => {
    const actor = startActor();
    openLive(actor);
    actor.send({ type: 'SERVER_ERROR', message: 'model hiccup' });
    const snap = actor.getSnapshot();
    expect(voicePhase(snap)).toBe('attending');
    expect(snap.context.error).toBe('model hiccup');
  });

  it('derives the orb state from phase and mute', () => {
    const actor = startActor();
    openLive(actor);
    expect(voiceOrbState(actor.getSnapshot())).toBe('listening');
    actor.send({ type: 'TOGGLE_MUTE' });
    expect(voiceOrbState(actor.getSnapshot())).toBe('idle');
    actor.send({ type: 'TOGGLE_MUTE' });
    actor.send({ type: 'RESPONSE_START' });
    expect(voiceOrbState(actor.getSnapshot())).toBe('thinking');
    actor.send({ type: 'PLAYBACK_ACTIVE' });
    expect(voiceOrbState(actor.getSnapshot())).toBe('speaking');
  });

  it('late transcript finals still land after TURN_ENDED', () => {
    const actor = startActor();
    openLive(actor);
    actor.send({ type: 'RESPONSE_START' });
    actor.send({ type: 'TURN_ENDED' });
    // Whisper lag: the user transcript for the turn arrives afterwards.
    actor.send({ type: 'TRANSCRIPT_FINAL', itemId: 'u9', role: 'user', text: 'late words' });
    expect(actor.getSnapshot().context.items.at(-1)).toMatchObject({ role: 'user', content: 'late words' });
  });
});

describe('transcript ordering', () => {
  /** Text of every chat item, in render order. */
  function transcript(actor: ReturnType<typeof startActor>) {
    return actor
      .getSnapshot()
      .context.items.filter((it) => it.type === 'chat')
      .map((it) => `${(it as { role: string }).role}:${(it as { content: string }).content}`);
  }

  it('puts a late user transcript above the answer it caused', () => {
    // The realtime API transcribes user audio asynchronously: the assistant
    // starts answering before the question's text exists. Arrival order puts
    // the answer first; the model's history order is the truth.
    const actor = startActor();
    openLive(actor);

    actor.send({ type: 'TRANSCRIPT_DELTA', itemId: 'item_assistant', delta: 'Sure, ' });
    actor.send({ type: 'TRANSCRIPT_DELTA', itemId: 'item_assistant', delta: 'here you go.' });
    expect(transcript(actor)).toEqual(['assistant:Sure, here you go.']);

    actor.send({ type: 'HISTORY_ORDER', itemIds: ['item_user', 'item_assistant'] });
    actor.send({ type: 'TRANSCRIPT_FINAL', itemId: 'item_user', role: 'user', text: 'read the file' });

    expect(transcript(actor)).toEqual(['user:read the file', 'assistant:Sure, here you go.']);
  });

  it('reorders items that already landed out of order', () => {
    const actor = startActor();
    openLive(actor);

    actor.send({ type: 'TRANSCRIPT_DELTA', itemId: 'item_assistant', delta: 'answer' });
    actor.send({ type: 'TRANSCRIPT_FINAL', itemId: 'item_user', role: 'user', text: 'question' });
    expect(transcript(actor)).toEqual(['assistant:answer', 'user:question']);

    // The snapshot that arrives with the transcription settles them.
    actor.send({ type: 'HISTORY_ORDER', itemIds: ['item_user', 'item_assistant'] });
    expect(transcript(actor)).toEqual(['user:question', 'assistant:answer']);
  });

  it('keeps a tool card attached to the message it followed', () => {
    const actor = startActor();
    openLive(actor);

    actor.send({ type: 'TRANSCRIPT_DELTA', itemId: 'item_assistant', delta: 'checking' });
    actor.send({ type: 'TOOL_START', callId: 'call-1', tool: 'read_file' });
    actor.send({ type: 'TRANSCRIPT_FINAL', itemId: 'item_user', role: 'user', text: 'question' });
    actor.send({ type: 'HISTORY_ORDER', itemIds: ['item_user', 'item_assistant'] });

    const kinds = actor.getSnapshot().context.items.map((it) => it.type);
    expect(kinds).toEqual(['chat', 'chat', 'tool']);
    expect(transcript(actor)).toEqual(['user:question', 'assistant:checking']);
  });

  it('leaves an unranked typed message where it was sent', () => {
    const actor = startActor();
    openLive(actor);

    actor.send({ type: 'SEND_TEXT', text: 'typed first' });
    actor.send({ type: 'TRANSCRIPT_DELTA', itemId: 'item_assistant', delta: 'spoken reply' });
    actor.send({ type: 'HISTORY_ORDER', itemIds: ['item_assistant'] });

    expect(transcript(actor)).toEqual(['user:typed first', 'assistant:spoken reply']);
  });

  it('keeps streaming deltas landing in the right bubble after a reorder', () => {
    const actor = startActor();
    openLive(actor);

    actor.send({ type: 'TRANSCRIPT_DELTA', itemId: 'item_assistant', delta: 'partial' });
    actor.send({ type: 'TRANSCRIPT_FINAL', itemId: 'item_user', role: 'user', text: 'question' });
    actor.send({ type: 'HISTORY_ORDER', itemIds: ['item_user', 'item_assistant'] });
    // The index map must have been rebuilt, or this delta opens a new bubble.
    actor.send({ type: 'TRANSCRIPT_DELTA', itemId: 'item_assistant', delta: ' more' });

    expect(transcript(actor)).toEqual(['user:question', 'assistant:partial more']);
  });

  it('ignores history ids it has no item for', () => {
    const actor = startActor();
    openLive(actor);

    actor.send({ type: 'TRANSCRIPT_DELTA', itemId: 'item_assistant', delta: 'reply' });
    actor.send({ type: 'HISTORY_ORDER', itemIds: ['item_gone', 'item_assistant', 'item_future'] });

    expect(transcript(actor)).toEqual(['assistant:reply']);
  });
});
