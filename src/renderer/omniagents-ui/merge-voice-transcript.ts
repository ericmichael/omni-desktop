/**
 * Merging the two streams a live voice session paints into one transcript.
 *
 * The chat-session machine's items arrive over `/ws` (canonical history,
 * plus anything that lands mid-call: a worker completion, a notification
 * turn, an approval). The voice-session machine's items arrive over
 * `/ws/realtime`. Neither carries a clock the other shares, so concatenating
 * them pinned every `/ws` arrival above the entire call.
 *
 * Instead the host keeps an arrival ledger: each time either stream grows,
 * the new entries are recorded in the order they showed up, and the merge
 * replays that order. Items then sit where they actually arrived.
 *
 * Pure and mutation-scoped: the ledger is the only state, and the caller
 * owns it (a ref, one per surface).
 */
import type { MessageItem } from '@/shared/chat-types';

/** 0 = chat stream, 1 = voice stream. */
type Stream = 0 | 1;

export type VoiceMergeLedger = {
  /** Non-approval chat items already recorded. */
  chat: number;
  /** Voice items already recorded. */
  voice: number;
  /** Which stream each merged slot came from, in arrival order. */
  order: Stream[];
};

export function createVoiceMergeLedger(): VoiceMergeLedger {
  return { chat: 0, voice: 0, order: [] };
}

function resetLedger(ledger: VoiceMergeLedger): void {
  ledger.chat = 0;
  ledger.voice = 0;
  ledger.order = [];
}

/**
 * One transcript for `items` + `voiceItems`, ordered by arrival.
 *
 * `voiceActive` false (or an empty voice stream) returns `items` untouched
 * and clears the ledger, so the next call starts clean.
 *
 * Approval cards are pulled out and re-appended last. A voice turn's tool
 * gate fires after everything already on screen, and the only actionable
 * card in the transcript belongs at the autoscroll target — keeping them
 * out of the ledger also keeps chat slots stable when one is resolved.
 */
export function mergeVoiceTranscript(
  items: MessageItem[],
  voiceItems: MessageItem[],
  ledger: VoiceMergeLedger,
  voiceActive: boolean
): MessageItem[] {
  if (!voiceActive || !voiceItems.length) {
    resetLedger(ledger);
    return items;
  }

  const chatItems: MessageItem[] = [];
  const pendingApprovals: MessageItem[] = [];
  for (const item of items) {
    (item.type === 'approval' ? pendingApprovals : chatItems).push(item);
  }

  if (chatItems.length < ledger.chat || voiceItems.length < ledger.voice) {
    // A stream shrank: the thread was replaced (session load, resync) or the
    // dock reopened. The recorded arrivals describe a transcript that no
    // longer exists, so fall back to stream order and start recording again.
    ledger.order = [
      ...(Array<Stream>(chatItems.length).fill(0) as Stream[]),
      ...(Array<Stream>(voiceItems.length).fill(1) as Stream[]),
    ];
  } else {
    for (let i = ledger.chat; i < chatItems.length; i++) {
      ledger.order.push(0);
    }
    for (let i = ledger.voice; i < voiceItems.length; i++) {
      ledger.order.push(1);
    }
  }
  ledger.chat = chatItems.length;
  ledger.voice = voiceItems.length;

  const merged: MessageItem[] = [];
  let chatIndex = 0;
  let voiceIndex = 0;
  for (const stream of ledger.order) {
    const next = stream === 0 ? chatItems[chatIndex++] : voiceItems[voiceIndex++];
    if (next) {
      merged.push(next);
    }
  }
  return [...merged, ...pendingApprovals];
}
