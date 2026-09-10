import { adaptCanonicalConversationItem } from '@/renderer/omniagents-ui/rpc/canonical-chat-history';
import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';
import { ConversationClient } from '@/renderer/omniagents-ui/rpc/conversation';
import { mcpArtifact } from '@/renderer/omniagents-ui/rpc/mcp-artifact';
import { PlanDiffRecovery } from '@/renderer/omniagents-ui/rpc/plan-diff-recovery';
import { PlansAndDiffsClient } from '@/renderer/omniagents-ui/rpc/plans-and-diffs';
import { HIDDEN_TOOLS } from '@/shared/transcript-items';

import type { ConversationSession } from './conversation-session';

/** Wire a fixed session, never a selected view, to its transcript actor. */
export function wireSessionTranscript(session: ConversationSession, client: RPCClient) {
  const actor = { getSnapshot: () => session.actor.getSnapshot(), send: session.receive };
  const conversations = new ConversationClient(client);
  const plansAndDiffs = new PlansAndDiffsClient(client);
  const planDiffRecovery = new PlanDiffRecovery(plansAndDiffs, conversations, () =>
    client.supportsExperimentalFeature('plansAndDiffs')
  );
  const adoptRecoveredItems = (threadId: string, recovered: Awaited<ReturnType<PlanDiffRecovery['recoverPlans']>>) => {
    if (threadId !== session.id || session.disposed) {
      return;
    }
    for (const item of recovered) {
      actor.send({ type: 'CANONICAL_ITEM_UPDATED', item, session_id: threadId });
    }
  };
  const recover = async () => {
    if (!client.supportsExperimentalFeature('plansAndDiffs')) {
      return;
    }
    const results = await Promise.allSettled([
      planDiffRecovery.recoverPlans(session.id),
      planDiffRecovery.recoverLatestRunDiff(session.id),
    ]);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        adoptRecoveredItems(session.id, result.value);
      }
    }
  };
  const offs = [
    session.on('message_output', (p: any) => {
      const content = String(p?.content ?? '');
      if (!content) {
        return;
      }
      actor.send({
        type: 'MESSAGE_OUTPUT',
        content,
        message_id: typeof p?.message_id === 'string' ? p.message_id : undefined,
        run_id: typeof p?.run_id === 'string' ? p.run_id : undefined,
        session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
      });
    }),

    session.on('run_started', (p: any) => {
      actor.send({
        type: 'RUN_STARTED',
        run_id: String(p?.run_id ?? ''),
        session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        // prompt: forwarded so the machine can append the originating
        // turn when RUN_STARTED arrives from idle (queued / background-
        // triggered runs). For runs originated by local submit(), the
        // optimistic append already happened and the machine's
        // idempotency check skips the duplicate.
        // prompt_role: tells the machine which role the appended turn
        // should carry — notification batches (worker / bash-job
        // completions) arrive as "assistant" so the wakeup reads as
        // the agent observing its own background activity rather than
        // a fake user message.
        prompt: typeof p?.prompt === 'string' ? p.prompt : undefined,
        prompt_role: typeof p?.prompt_role === 'string' ? p.prompt_role : undefined,
      });
    }),

    session.on('run_end', (p: any) => {
      const threadId = typeof p?.session_id === 'string' ? p.session_id : '';
      actor.send({
        type: 'RUN_END',
        run_id: typeof p?.run_id === 'string' ? p.run_id : undefined,
        session_id: threadId || undefined,
      });
      if (threadId && client.supportsExperimentalFeature('plansAndDiffs')) {
        void planDiffRecovery
          // run_end exposes a run_id, not the canonical conversation
          // turn_id accepted by get_run_diff. Ask for the authoritative
          // latest completed turn instead of assuming those identities match.
          .recoverLatestRunDiff(threadId)
          .then((recovered) => adoptRecoveredItems(threadId, recovered))
          .catch(() => {
            // The canonical transcript and reconnect recovery remain the
            // durable fallback for a transient post-run read failure.
          });
      }
    }),

    session.on('run_status', (p: any) => {
      const msg = [p?.status, p?.message].filter(Boolean).join(': ');
      actor.send({
        type: 'RUN_STATUS',
        text: msg,
        session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
      });
    }),

    session.on('token', (p: any) => {
      actor.send({
        type: 'TOKEN',
        session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
      });
    }),

    session.on('tool_called', (p: any) => {
      const tool = String(p?.tool ?? '');
      if (HIDDEN_TOOLS.has(tool)) {
        return;
      }
      actor.send({
        type: 'TOOL_CALLED',
        call_id: String(p?.call_id ?? ''),
        tool,
        input: typeof p?.input === 'string' ? p.input : JSON.stringify(p?.input),
        metadata: p?.metadata,
        server_label: typeof p?.server_label === 'string' ? p.server_label : undefined,
        tool_label: typeof p?.tool_label === 'string' ? p.tool_label : undefined,
        run_id: typeof p?.run_id === 'string' ? p.run_id : undefined,
        session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
      });
    }),

    session.on('tool_result', (p: any) => {
      const callId = String(p?.call_id ?? '');
      const tool = String(p?.tool ?? '');
      if (HIDDEN_TOOLS.has(tool)) {
        return;
      }
      const output = typeof p?.output === 'string' ? p.output : JSON.stringify(p?.output);
      const metadata = p?.metadata;
      actor.send({
        type: 'TOOL_RESULT',
        call_id: callId,
        tool,
        output,
        metadata,
        server_label: typeof p?.server_label === 'string' ? p.server_label : undefined,
        tool_label: typeof p?.tool_label === 'string' ? p.tool_label : undefined,
        run_id: typeof p?.run_id === 'string' ? p.run_id : undefined,
        session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
      });
      // MCP-Apps: if omniagents attached an ``mcp_ui`` payload, surface
      // it as a standalone artifact in the stream. Tool-card grouping
      // collapses interactive UIs into the activity group; artifacts
      // render full-width with their own framing.
      //
      // Two flavors:
      //   • ``ui.resource`` — inline HTML (mcp-ui demo)
      //   • ``ui.resource_uri`` + ``ui.structured_content`` — shared
      //     renderer fetched via ``mcp.read_resource`` (FastMCP /
      //     Prefab). The McpUiSurface renderer handles both.
      const artifact = mcpArtifact({
        sessionId: session.id,
        runId: typeof p?.run_id === 'string' ? p.run_id : actor.getSnapshot().context.runId,
        callId,
        tool,
        output,
        metadata,
      });
      if (artifact) {
        actor.send({
          ...artifact,
          type: 'ADD_ARTIFACT',
        });
      }
    }),

    // Tool-approval interruption events (omniagents 0.16+). The server
    // pauses the run on a ``ToolApprovalItem`` and emits
    // ``tool_approval_requested``; we surface it to the state machine
    // and answer back via ``client.toolApprovalResponse``. When
    // another channel responds first, the server broadcasts
    // ``tool_approval_resolved`` so we dismiss the pending card.
    // ``call_id`` is the server-issued approval token; the state machine
    // historically uses ``request_id`` for the same role, so we map
    // at the wire boundary rather than touching every machine consumer.
    session.on('tool_approval_requested', (p: any) => {
      const call_id = String(p?.call_id ?? '');
      if (!call_id) {
        return;
      }
      actor.send({
        type: 'REQUEST_APPROVAL',
        request_id: call_id,
        run_id: typeof p?.run_id === 'string' ? p.run_id : undefined,
        tool: String(p?.tool_name ?? ''),
        argumentsText: String(p?.arguments ?? ''),
        metadata: p?.metadata,
        server_label: typeof p?.server_label === 'string' ? p.server_label : undefined,
        tool_label: typeof p?.tool_label === 'string' ? p.tool_label : undefined,
        session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
      });
    }),

    session.on('tool_approval_resolved', (p: any) => {
      const call_id = String(p?.call_id ?? '');
      if (call_id) {
        actor.send({ type: 'APPROVAL_RESOLVED', request_id: call_id });
      }
    }),

    // Reviewer/sandbox-resolved approvals that never surfaced as prompts
    // (guardian "Approve for me" and sandbox auto-approval). Journaled, so
    // replay re-delivers them; the machine appends a transcript chip.
    session.on('tool_approval_reviewed', (p: any) => {
      const call_id = String(p?.call_id ?? '');
      const outcome = p?.outcome === 'deny' ? 'deny' : p?.outcome === 'allow' ? 'allow' : null;
      if (!call_id || !outcome) {
        return;
      }
      actor.send({
        type: 'GUARDIAN_REVIEWED',
        request_id: call_id,
        tool: String(p?.tool_name ?? 'tool'),
        reviewer: String(p?.reviewer ?? 'reviewer'),
        outcome,
        risk_level: typeof p?.risk_level === 'string' ? p.risk_level : undefined,
        rationale: typeof p?.rationale === 'string' ? p.rationale : undefined,
        kind: p?.kind === 'mcp' ? 'mcp' : 'tool',
        server_label: typeof p?.server_label === 'string' ? p.server_label : undefined,
        session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
      });
    }),

    // Plan-step completion reviews (workflow enforcement). The server
    // broadcasts every reviewed outcome — reject / accept_unverified /
    // escalated / accept_verified; only waived completions stay silent.
    // Older runtimes never emit this; parse defensively.
    session.on('plan_completion_reviewed', (p: any) => {
      const task_id = String(p?.task_id ?? '');
      const outcome =
        p?.outcome === 'reject' ||
        p?.outcome === 'accept_unverified' ||
        p?.outcome === 'escalated' ||
        p?.outcome === 'accept_verified'
          ? p.outcome
          : null;
      if (!task_id || !outcome) {
        return;
      }
      actor.send({
        type: 'WORKFLOW_REVIEWED',
        task_id,
        subject: String(p?.subject ?? ''),
        outcome,
        reviewer: String(p?.reviewer ?? 'reviewer'),
        rationale: typeof p?.rationale === 'string' ? p.rationale : undefined,
        session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
      });
    }),

    // Hosted-MCP approval flow (omniagents 0.16+). Parallel to the
    // function-tool path but keyed by ``request_id`` (the model's
    // server-issued approval token) and identifies the MCP server via
    // ``server_label``. There is no ``always_approve`` affordance on
    // this path — the server intentionally omits it for MCP.
    session.on('mcp_approval_requested', (p: any) => {
      const request_id = String(p?.request_id ?? '');
      if (!request_id) {
        return;
      }
      actor.send({
        type: 'REQUEST_APPROVAL',
        request_id,
        run_id: typeof p?.run_id === 'string' ? p.run_id : undefined,
        tool: String(p?.tool_name ?? ''),
        argumentsText: String(p?.arguments ?? ''),
        metadata: p?.metadata,
        session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        kind: 'mcp',
        server_label: typeof p?.server_label === 'string' ? p.server_label : undefined,
      });
    }),

    session.on('mcp_approval_resolved', (p: any) => {
      const request_id = String(p?.request_id ?? '');
      if (request_id) {
        actor.send({ type: 'APPROVAL_RESOLVED', request_id });
      }
    }),

    // Plans, run diffs and append-only queue messages have no legacy
    // transcript delta. Fetch the complete authoritative item before
    // projecting it so additive fields are preserved and replay/live paths
    // converge through the same revision-aware machine action.
    session.on('item_updated', (p: any) => {
      const message = p?.kind === 'user_message' || p?.kind === 'agent_message';
      if (
        !client.supportsExperimentalFeature('plansAndDiffs') ||
        (!message && p?.kind !== 'plan' && p?.kind !== 'run_diff')
      ) {
        return;
      }
      const threadId = typeof p?.thread_id === 'string' ? p.thread_id : '';
      const itemId = typeof p?.item_id === 'string' ? p.item_id : '';
      if (!threadId || !itemId || actor.getSnapshot().context.sessionId !== threadId) {
        return;
      }
      void conversations
        .getItem(threadId, itemId)
        .then((item) => {
          if (
            session.disposed ||
            actor.getSnapshot().context.sessionId !== threadId ||
            item.thread_id !== threadId ||
            item.item_id !== itemId
          ) {
            return;
          }
          // A persisted provider response can survive an SDK error that
          // discards message_output. Stable identity also merges a delayed
          // stream event; ID-less prompts still use their dedicated path.
          const providerOutput =
            item.kind === 'agent_message' &&
            item.source_ref.event === 'message_output' &&
            typeof item.content.message_id === 'string' &&
            item.content.message_id.length > 0;
          if (message && item.source_ref.event !== 'enqueue_message' && !providerOutput) {
            return;
          }
          actor.send({
            type: 'CANONICAL_ITEM_UPDATED',
            item: adaptCanonicalConversationItem(item),
            session_id: threadId,
          });
        })
        .catch(() => {
          // Durable replay or the next authoritative transcript load repairs
          // a transient read failure. Never retry this read as a mutation.
        });
    }),
  ];

  return {
    recover,
    dispose: () => {
      offs.forEach((off) => off());
      plansAndDiffs.dispose();
    },
  };
}
