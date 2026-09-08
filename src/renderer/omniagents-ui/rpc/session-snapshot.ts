import { ConversationProtocolError, decodeConversationItem } from './conversation';

/** Validate the complete hydration boundary before any controller mutates. */
export function decodeSessionSnapshot(result: any, sessionId: string) {
  const snapshot = result?.snapshot;
  if (!snapshot || typeof snapshot.stream_id !== 'string' || !snapshot.stream_id) {
    throw new ConversationProtocolError('This runtime needs an update to support consistent conversation snapshots.');
  }
  if (
    result.session_id !== sessionId ||
    typeof result.run_active !== 'boolean' ||
    (result.run_active && (typeof result.active_run_id !== 'string' || !result.active_run_id)) ||
    !Number.isSafeInteger(snapshot.last_seq) ||
    snapshot.last_seq < 0 ||
    !Array.isArray(snapshot.items) ||
    !Array.isArray(snapshot.queue) ||
    !Array.isArray(snapshot.pending_requests)
  ) {
    throw new ConversationProtocolError('Invalid conversation snapshot identity or watermark');
  }
  const ids = new Set<string>();
  let previous = -1;
  const items = snapshot.items.map((value: unknown) => {
    const item = decodeConversationItem(value);
    if (item.thread_id !== sessionId || ids.has(item.item_id) || item.seq <= previous) {
      throw new ConversationProtocolError('Conversation snapshot contains foreign, duplicate or unordered items');
    }
    ids.add(item.item_id);
    previous = item.seq;
    return item;
  });
  for (const request of snapshot.pending_requests) {
    if (
      request?.session_id !== sessionId ||
      typeof request.request_id !== 'string' ||
      !request.request_id ||
      typeof request.function !== 'string'
    ) {
      throw new ConversationProtocolError('Conversation snapshot contains an invalid pending request');
    }
  }
  if (!Array.isArray(snapshot.state_events ?? [])) {
    throw new ConversationProtocolError('Invalid conversation display state');
  }
  for (const event of snapshot.state_events ?? []) {
    if (
      event?.params?.session_id !== sessionId ||
      !(
        event.method === 'run_status' ||
        (event.method === 'client_request' && ['ui.set_status', 'ui.set_session_state'].includes(event.params.function))
      )
    ) {
      throw new ConversationProtocolError('Conversation display state cannot execute client actions');
    }
  }
  return { ...result, snapshot: { ...snapshot, items } };
}
