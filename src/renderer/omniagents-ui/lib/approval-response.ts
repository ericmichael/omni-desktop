/**
 * Answering one approval prompt on the wire.
 *
 * Shared by every surface that renders approval cards — the chat column
 * (App.tsx) and the resident DM voice dock — so both speak the same two
 * RPCs with the same failure behavior. The card UI and the machine event
 * (`APPROVAL_DECIDED`) stay with the caller; this is only the transport.
 */
import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';

export type ApprovalDecisionValue = 'yes' | 'always' | 'no';

/** The client surface an approval answer needs — narrow so tests can fake it. */
export type ApprovalResponder = Pick<RPCClient, 'toolApprovalResponse' | 'mcpApprovalResponse'>;

/**
 * ``request_id`` is the opaque server-issued approval token stored on the
 * ApprovalItem when the approval event arrived (see use-chat-session.ts):
 *
 *   - kind 'function' → event call_id    → tool_approval_response RPC
 *   - kind 'mcp'      → event request_id → mcp_approval_response RPC
 *
 * Both take ``decision: "approve" | "reject"``; only the function path
 * honors ``always_approve``.
 */
export async function respondToApproval(
  client: ApprovalResponder,
  request_id: string,
  value: ApprovalDecisionValue,
  kind: 'function' | 'mcp' = 'function'
): Promise<void> {
  const decision = value === 'no' ? 'reject' : 'approve';
  const alwaysApprove = value === 'always';
  // An uncertain acknowledgement is not permission to reverse the user's
  // decision. Leave the card pending so replay or an explicit retry resolves it.
  const accepted =
    kind === 'mcp'
      ? await client.mcpApprovalResponse(request_id, decision)
      : await client.toolApprovalResponse(request_id, decision, alwaysApprove);
  if (accepted !== true) {
    throw new Error('This approval is no longer pending. Refresh the conversation to reconcile its status.');
  }
}
