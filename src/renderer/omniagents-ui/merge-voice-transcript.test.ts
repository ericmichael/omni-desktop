import { describe, expect, it } from 'vitest';

import type { ApprovalItem, ChatMessage, MessageItem } from '@/shared/chat-types';

import { createVoiceMergeLedger, mergeVoiceTranscript } from './merge-voice-transcript';

function chat(content: string, role: ChatMessage['role'] = 'assistant'): ChatMessage {
  return { type: 'chat', role, content };
}

function approval(request_id: string): ApprovalItem {
  return { type: 'approval', request_id, tool: 'bash' };
}

function text(items: MessageItem[]): string[] {
  return items.map((it) => (it.type === 'chat' ? it.content : `${it.type}:${(it as ApprovalItem).request_id ?? ''}`));
}

describe('mergeVoiceTranscript', () => {
  it('passes the chat transcript through when voice is closed', () => {
    const ledger = createVoiceMergeLedger();
    const items = [chat('a'), chat('b')];
    expect(mergeVoiceTranscript(items, [], ledger, false)).toBe(items);
    expect(ledger.order).toEqual([]);
  });

  it('keeps a /ws arrival where it landed instead of above the whole call', () => {
    const ledger = createVoiceMergeLedger();
    const history = [chat('older turn')];

    // Two spoken turns...
    let merged = mergeVoiceTranscript(history, [chat('voice 1')], ledger, true);
    expect(text(merged)).toEqual(['older turn', 'voice 1']);

    // ...then a worker completion lands on /ws...
    merged = mergeVoiceTranscript([...history, chat('worker done')], [chat('voice 1')], ledger, true);
    expect(text(merged)).toEqual(['older turn', 'voice 1', 'worker done']);

    // ...and the call continues.
    merged = mergeVoiceTranscript([...history, chat('worker done')], [chat('voice 1'), chat('voice 2')], ledger, true);
    expect(text(merged)).toEqual(['older turn', 'voice 1', 'worker done', 'voice 2']);
  });

  it('appends pending approvals last wherever they arrived', () => {
    const ledger = createVoiceMergeLedger();
    const merged = mergeVoiceTranscript(
      [chat('history'), approval('req-1')],
      [chat('voice 1'), chat('voice 2')],
      ledger,
      true
    );
    expect(text(merged)).toEqual(['history', 'voice 1', 'voice 2', 'approval:req-1']);
  });

  it('keeps chat slots stable when an approval resolves', () => {
    const ledger = createVoiceMergeLedger();
    const withApproval = [chat('history'), approval('req-1')];
    mergeVoiceTranscript(withApproval, [chat('voice 1')], ledger, true);
    mergeVoiceTranscript(withApproval, [chat('voice 1'), chat('voice 2')], ledger, true);

    // Resolving the approval shrinks `items`, but the non-approval stream is
    // untouched — the recorded arrivals must survive.
    const merged = mergeVoiceTranscript([chat('history')], [chat('voice 1'), chat('voice 2')], ledger, true);
    expect(text(merged)).toEqual(['history', 'voice 1', 'voice 2']);
  });

  it('falls back to stream order when the thread is replaced', () => {
    const ledger = createVoiceMergeLedger();
    mergeVoiceTranscript([chat('a'), chat('b')], [chat('voice 1')], ledger, true);

    // A resync replaces the transcript with a shorter one.
    const merged = mergeVoiceTranscript([chat('reloaded')], [chat('voice 1')], ledger, true);
    expect(text(merged)).toEqual(['reloaded', 'voice 1']);
    expect(ledger.chat).toBe(1);
    expect(ledger.voice).toBe(1);
  });

  it('clears the ledger when the dock closes so the next call starts clean', () => {
    const ledger = createVoiceMergeLedger();
    mergeVoiceTranscript([chat('history')], [chat('voice 1')], ledger, true);
    mergeVoiceTranscript([chat('history'), chat('voice 1 recorded')], [], ledger, false);
    expect(ledger.order).toEqual([]);

    const merged = mergeVoiceTranscript([chat('history'), chat('voice 1 recorded')], [chat('new call')], ledger, true);
    expect(text(merged)).toEqual(['history', 'voice 1 recorded', 'new call']);
  });

  it('is idempotent across repeated renders with no new items', () => {
    const ledger = createVoiceMergeLedger();
    const items = [chat('history')];
    const voice = [chat('voice 1')];
    const first = mergeVoiceTranscript(items, voice, ledger, true);
    const second = mergeVoiceTranscript(items, voice, ledger, true);
    expect(text(second)).toEqual(text(first));
    expect(ledger.order).toHaveLength(2);
  });

  it('reflects a voice-side reorder without disturbing the chat slots', () => {
    const ledger = createVoiceMergeLedger();
    mergeVoiceTranscript([chat('history')], [chat('answer'), chat('question', 'user')], ledger, true);

    // The voice machine re-sorts its own items on realtime_history_updated.
    const merged = mergeVoiceTranscript([chat('history')], [chat('question', 'user'), chat('answer')], ledger, true);
    expect(text(merged)).toEqual(['history', 'question', 'answer']);
  });
});
