/**
 * Shared types for the chat/conversation UI.
 *
 * These live in `shared/` so they can be used by both the renderer
 * (MessageList, App) and the pure chat-session state machine.
 */

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export type Attachment = {
  type: 'image' | 'file';
  url?: string;
  filename?: string;
  mime?: string;
  size?: number;
};

// ---------------------------------------------------------------------------
// Message items
// ---------------------------------------------------------------------------

/**
 * Canonical conversation identity retained on UI rows loaded through the v2
 * conversation surface. Keeping the original structured content here makes
 * adapters additive: newer server fields and item kinds survive even when the
 * current renderer only has a compact presentation for them.
 */
export type CanonicalItemEnvelope = {
  item_id: string;
  thread_id: string;
  turn_id: string | null;
  seq: number;
  kind: string;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  revision: number;
  created_at: number;
  updated_at: number;
  content: Record<string, unknown>;
  source_ref: Record<string, unknown>;
};

export type ChatMessage = {
  type: 'chat';
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * Realtime conversation item id, stamped by the voice-session machine on
   * live voice turns. Live items carry no canonical envelope, so this is the
   * only stable identity a spoken turn has — and it needs one, because the
   * voice transcript re-sorts itself into the model's item order.
   */
  item_id?: string;
  timestamp?: string;
  attachments?: Attachment[];
  /**
   * MCP-Apps staged context entries that were flushed and prepended to
   * the agent's prompt on this user turn. The visible ``content`` shows
   * just the user's typed text; this field records what extra context
   * the model actually saw, so the chat log makes it obvious that
   * something was attached.
   */
  staged_context?: ReadonlyArray<{ source: string; text: string }>;
  /**
   * The run this assistant message belongs to, stamped by the chat-session
   * machine on live-appended messages. Live items carry no canonical
   * envelope, so without this stamp activity grouping cannot place a
   * narration message in its run's chain until a reload rebuilds the
   * transcript from canonical items (whose ``turn_id`` serves the same
   * role). User messages are never stamped — they always break the chain.
   */
  runId?: string;
  canonical?: CanonicalItemEnvelope;
};

export type ToolItem = {
  type: 'tool';
  call_id?: string;
  /** Flat wire name (for MCP-derived tools the prefixed ``mcp_<server>__<tool>``). */
  tool: string;
  /** MCP server name when the tool is MCP-derived — display as a suffix, never parse `tool`. */
  server_label?: string;
  /** Original (unprefixed) MCP tool name for display. */
  tool_label?: string;
  input?: string;
  output?: string;
  status: 'called' | 'result';
  metadata?: ChatItemMetadata;
  runId?: string;
  canonical?: CanonicalItemEnvelope;
};

export type ApprovalItem = {
  type: 'approval';
  // ``request_id`` is the model-minted identifier we echo back on the
  // decision RPC. For ``kind: 'function'`` it's the tool ``call_id``
  // (omniagents 0.16 ``tool_approval_requested``). For ``kind: 'mcp'``
  // it's the McpApprovalRequest id (omniagents 0.16 ``mcp_approval_requested``).
  request_id: string;
  tool: string;
  argumentsText?: string;
  metadata?: ChatItemMetadata;
  session_id?: string;
  // Discriminator. Defaults to 'function' for back-compat with existing
  // approval items already in items[] when this field was introduced.
  kind?: 'function' | 'mcp';
  // Identifies the MCP server: set for ``kind: 'mcp'`` (hosted), and for
  // ``kind: 'function'`` approvals of local-MCP-derived tools.
  server_label?: string;
  // Original (unprefixed) MCP tool name for display on local-MCP approvals.
  tool_label?: string;
  canonical?: CanonicalItemEnvelope;
};

/**
 * A reviewer/sandbox-resolved approval decision that never reached the user
 * as a prompt (omniagents ``tool_approval_reviewed``). Rendered as a compact
 * transcript chip so the record shows what was auto-approved or denied and by
 * whom.
 */
export type GuardianReviewItem = {
  type: 'guardian_review';
  request_id: string;
  tool: string;
  /** 'guardian' | 'sandbox-policy' (open set — render verbatim fallback). */
  reviewer: string;
  outcome: 'allow' | 'deny';
  risk_level?: string;
  rationale?: string;
  kind?: 'tool' | 'mcp';
  server_label?: string;
  session_id?: string;
  canonical?: CanonicalItemEnvelope;
};

/**
 * A plan-step completion review outcome broadcast by the workflow layer
 * (omniagents ``plan_completion_reviewed``). Emitted only for the three
 * outcomes that need transcript visibility — rejections, unverified accepts,
 * and breaker escalations; clean verifications stay silent. Rendered as a
 * compact chip so a denied completion doesn't read as an unexplained retry.
 */
export type WorkflowReviewItem = {
  type: 'workflow_review';
  task_id: string;
  subject: string;
  outcome: 'reject' | 'accept_unverified' | 'escalated' | 'accept_verified';
  /** 'guardian' | 'human' | 'none' (open set — render verbatim fallback). */
  reviewer: string;
  rationale?: string;
  session_id?: string;
  canonical?: CanonicalItemEnvelope;
};

export type ChatItemMetadata = {
  hidden?: boolean;
  summary?: string;
  display_type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export type PlanStep = {
  title: string;
  description?: string;
  id?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'blocked';
  owner?: string;
  blockedBy?: string[];
  /** Checkable definition-of-done. Absent/empty = no semantic review. */
  exitCriteria?: string;
  /** Completion review: true verified, false unverified, null/absent unreviewed. */
  verified?: boolean | null;
  /** True when the criteria were edited while the step was in progress (ratchet stamp). */
  criteriaEdited?: boolean;
};

export type PlanItem = {
  type: 'plan';
  id: string;
  title: string;
  description?: string;
  steps: PlanStep[];
  scope?: string;
  status?: CanonicalItemEnvelope['status'];
  canonical?: CanonicalItemEnvelope;
};

export type RunDiffFile = {
  path: string;
  changeType: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  opaque: boolean;
  baselineUnknown: boolean;
};

export type RunDiffItem = {
  type: 'run_diff';
  id: string;
  diff: string;
  files: RunDiffFile[];
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
  truncated: boolean;
  filesTruncated: boolean;
  status: CanonicalItemEnvelope['status'];
  canonical: CanonicalItemEnvelope;
};

export type ReasoningItem = {
  type: 'reasoning';
  summary: string;
  status: CanonicalItemEnvelope['status'];
  canonical: CanonicalItemEnvelope;
};

/** Explicit forward-compatible presentation for canonical kinds without a
 * purpose-built transcript component yet (including future unknown kinds). */
export type StructuredItem = {
  type: 'structured';
  kind: string;
  title: string;
  summary?: string;
  canonical: CanonicalItemEnvelope;
};

/**
 * Optional MCP-Apps UI payload attached to an artifact. When present the
 * renderer mounts the mcp-ui ``<AppRenderer>`` in place of the generic
 * artifact body. ``server_name`` is used to route ``tools/call`` and
 * ``resources/read`` postMessage actions back to the originating MCP
 * server via omniagents' ``mcp.*`` server functions.
 */
export type ArtifactMcpUi = {
  server_name: string;
  tool_name: string;
  tool_input?: unknown;
  tool_output?: string;
  /**
   * Inline UI payload (mcp-ui demo flavor) — the renderer extracts the
   * HTML from ``resource.resource.text`` directly. Mutually exclusive
   * with ``resource_uri``.
   */
  resource?: {
    type?: string;
    resource?: {
      uri?: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    };
  };
  /**
   * MCP Apps ``_meta.ui.resourceUri`` (FastMCP / Prefab flavor) — the
   * host fetches the renderer HTML from this URI via ``mcp.read_resource``
   * and forwards ``structured_content`` to it as the tool result.
   */
  resource_uri?: string;
  /**
   * ``CallToolResult.structuredContent`` produced by the MCP server.
   * Passed to ``AppRenderer`` as ``toolResult.structuredContent`` so the
   * resource-shared renderer (e.g. Prefab's React bundle) knows what to
   * render for this specific call.
   */
  structured_content?: unknown;
};

export type ArtifactItem = {
  type: 'artifact';
  artifact_id?: string;
  title: string;
  content: string;
  mode?: string;
  session_id?: string;
  updated_at?: number;
  /** Set for MCP-Apps UI resources surfaced via tool_result metadata. */
  mcp_ui?: ArtifactMcpUi;
  canonical?: CanonicalItemEnvelope;
};

export type MessageItem =
  | ChatMessage
  | ToolItem
  | ApprovalItem
  | GuardianReviewItem
  | WorkflowReviewItem
  | ArtifactItem
  | ReasoningItem
  | PlanItem
  | RunDiffItem
  | StructuredItem;
