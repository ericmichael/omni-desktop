export type JsonRpcId = string | number;
export type JsonRpcError = { code: number; message: string; data?: unknown };
export interface Identity { name: string; version: string }
export interface Platform { os: string; arch: string }
export interface Capabilities { realtime: boolean; mcp_apps: boolean; client_functions: boolean; approvals: boolean; artifacts: boolean; replay: boolean; terminal: boolean; experimental_operations: string[]; disabled_notifications: string[] }
export interface AgentHostDescriptor { agent_host_id: string; default_workspace_id?: string | null; default_environment_id?: string | null }
export type EnvironmentSelection = { mode: "inherit" } | { mode: "none" } | { mode: "explicit"; environment_id: string; environment_generation?: number };
export interface InitializeParams {
  protocol_version: string;
  identity: Identity;
  platform: Platform;
  capabilities: Capabilities;
}
export interface InitializeResult { protocol_version: string; identity: Identity; platform: Platform; capabilities: Capabilities; agent_host: AgentHostDescriptor }
export interface StartRunParams {
  prompt: string;
  environment_selection: EnvironmentSelection;
  session_id?: string;
  variables?: Record<string, unknown>;
  context?: Record<string, unknown>;
  content?: string;
  workflow_name?: string;
  group_id?: string;
  safe_tool_overrides?: Record<string, unknown>;
  prompt_role?: string;
}
export interface StartRunResult { run_id: string; session_id: string }
export interface StopRunParams {
  run_id: string;
}
export interface SendUserMessageParams {
  run_id: string;
  content: string;
}
export interface GetSessionHistoryParams {
  session_id: string;
}
export interface ListSessionsParams {
  limit?: number;
  offset?: number;
}
export interface ArchiveSessionParams {
  session_id: string;
}
export interface DeleteSessionParams {
  session_id: string;
  cascade?: boolean;
}
export interface GetUserHistoryParams {
  limit?: number;
  include_archived?: boolean;
}
export interface GetAgentInfoParams {
}
export interface ToolApprovalResponseParams {
  call_id: string;
  decision: string;
  always_approve?: boolean;
  rejection_message?: string;
}
export interface McpApprovalResponseParams {
  request_id: string;
  decision: string;
  rejection_message?: string;
}
export interface ClientFunctionsParams {
  functions: unknown[];
  version?: number;
}
export interface ClientResponseParams {
  request_id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}
export interface ListServerFunctionsParams {
}
export interface ServerCallParams {
  function: string;
  args?: Record<string, unknown>;
  session_id?: string;
  environment_id?: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface EnqueueMessageParams {
  session_id: string;
  content: string;
  role?: string;
  trigger_run?: boolean;
  variables?: Record<string, unknown>;
  safe_tool_overrides?: Record<string, unknown>;
  source?: string;
}
export interface ListQueueParams {
  session_id: string;
}
export interface CancelQueuedMessageParams {
  session_id: string;
  item_id: string;
}
export interface ResumeSessionParams {
  session_id: string;
  stream_id?: string;
  after_seq?: number;
}
export interface AckEventsParams {
  session_id: string;
  stream_id: string;
  seq: number;
}
export interface ListModelsParams {
  include_hidden?: boolean;
  modality?: string;
  session_id?: string;
}
export interface GetModelParams {
  model: string;
}
export interface ListProvidersParams {
}
export interface SetSessionModelParams {
  session_id: string;
  model: string;
}
export interface SetSessionReasoningParams {
  session_id: string;
  effort: string;
}
export interface SetVoiceModelParams {
  model: string;
}
export interface AccountStatusParams {
}
export interface AccountLoginStartParams {
  provider: string;
  mode: string;
  api_key?: string;
  redirect_uri?: string;
}
export interface AccountLoginCompleteParams {
  login_id: string;
  code?: string;
}
export interface AccountLoginCancelParams {
  login_id: string;
}
export interface AccountLogoutParams {
  provider: string;
}
export interface AccountRefreshParams {
  provider: string;
}
export interface AccountUsageParams {
  provider?: string;
}
export interface AccountSelectParams {
  provider: string;
}
export interface ElicitationResponseParams {
  elicitation_id: string;
  action: string;
  value?: Record<string, unknown>;
  reason?: string;
}
export interface McpListServersParams {
  session_id?: string;
}
export interface McpGetServerParams {
  server_name: string;
  refresh?: boolean;
}
export interface McpCreateServerParams {
  server_name: string;
  type: string;
  params: Record<string, unknown>;
  server_options?: Record<string, unknown>;
}
export interface McpUpdateServerParams {
  server_name: string;
  type?: string;
  params?: Record<string, unknown>;
  server_options?: Record<string, unknown>;
}
export interface McpDeleteServerParams {
  server_name: string;
}
export interface McpReloadServerParams {
  server_name?: string;
}
export interface McpAuthStartParams {
  server_name: string;
  redirect_uri?: string;
  session_id?: string;
}
export interface McpAuthCompleteParams {
  auth_id: string;
  code: string;
}
export interface McpAuthCancelParams {
  auth_id: string;
}
export interface GetThreadParams {
  thread_id: string;
}
export interface ListTurnsParams {
  thread_id: string;
  limit?: number;
  cursor?: string;
  order?: string;
}
export interface ListItemsParams {
  thread_id: string;
  turn_id?: string;
  kinds?: unknown[];
  limit?: number;
  cursor?: string;
  order?: string;
}
export interface GetItemParams {
  thread_id: string;
  item_id: string;
}
export interface AgentHostRegisterWorkspaceParams {
  workspace_id: string;
  materialization_path: string;
  snapshot_ref?: string;
  sources?: unknown[];
  owner_user_id?: string;
}
export interface AgentHostRegisterProfileParams {
  profile_id: string;
  definition: Record<string, unknown>;
  owner_user_id?: string;
}
export interface AgentHostBindThreadParams {
  thread_id: string;
  binding: Record<string, unknown>;
}
export interface AgentHostListResourcesParams {
}
export interface AgentHostMaterializeEnvironmentParams {
  workspace_id: string;
  profile_id: string;
}
export interface AgentHostStopEnvironmentParams {
  environment_id: string;
}
export interface ForkSessionParams {
  session_id: string;
  new_session_id?: string;
  from_item_id?: string;
  from_turn_id?: string;
}
export interface SetSessionHoldParams {
  session_id: string;
  hold: boolean;
}
export interface QueueStatusParams {
  session_id: string;
}
export interface EnqueueNotificationParams {
  session_id: string;
  content: string;
  source?: string;
  safe_tool_overrides?: Record<string, unknown>;
}
export interface UpdateSessionVariablesParams {
  session_id: string;
  updates: Record<string, unknown>;
}
export interface SetClientStatusParams {
  text: string;
}
export interface DisableToolParams {
  tool_name: string;
}
export interface DisableMcpServerParams {
  server_name: string;
}
export interface ReportIncidentParams {
  session_id: string;
  description: string;
  disable_tools?: unknown[];
  disable_mcp_servers?: unknown[];
}
export interface ExportSessionParams {
  session_id: string;
  redact?: boolean;
}
export interface GetConfigParams {
}
export interface ValidateConfigParams {
  updates: Record<string, unknown>;
}
export interface WriteConfigParams {
  updates: Record<string, unknown>;
}
export interface McpReadResourceParams {
  server_name: string;
  uri: string;
  session_id?: string;
}
export interface McpCallToolParams {
  server_name: string;
  tool_name: string;
  session_id: string;
  args?: Record<string, unknown>;
}
export interface McpGetPromptParams {
  server_name: string;
  prompt_name: string;
  args?: Record<string, unknown>;
  session_id?: string;
}
export interface FsWatchParams {
  environment_id: string;
  path: string;
  recursive?: boolean;
  poll_interval_ms?: number;
  workspace_id?: string;
  environment_generation?: number;
}
export interface FsUnwatchParams {
  environment_id: string;
  watch_id: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface FsListParams {
  environment_id: string;
  path: string;
  recursive?: boolean;
  workspace_id?: string;
  environment_generation?: number;
}
export interface FsStatParams {
  environment_id: string;
  path: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface FsDownloadOpenParams {
  environment_id: string;
  path: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface FsDownloadReadParams {
  environment_id: string;
  transfer_id: string;
  offset?: number;
  length?: number;
  workspace_id?: string;
  environment_generation?: number;
}
export interface FsDownloadCloseParams {
  environment_id: string;
  transfer_id: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface FsUploadOpenParams {
  environment_id: string;
  path: string;
  size: number;
  sha256?: string;
  expected_sha256?: string;
  overwrite?: boolean;
  workspace_id?: string;
  environment_generation?: number;
}
export interface FsUploadChunkParams {
  environment_id: string;
  transfer_id: string;
  offset: number;
  data: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface FsUploadCommitParams {
  environment_id: string;
  transfer_id: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface FsUploadAbortParams {
  environment_id: string;
  transfer_id: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitListRepositoriesParams {
  environment_id: string;
  path?: string;
  max_depth?: number;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitStatusParams {
  environment_id: string;
  repo: string;
  include_untracked?: boolean;
  include_ignored?: boolean;
  paths?: unknown[];
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitDiffParams {
  environment_id: string;
  repo: string;
  mode?: string;
  paths?: unknown[];
  context_lines?: number;
  from_rev?: string;
  to_rev?: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitLogParams {
  environment_id: string;
  repo: string;
  rev?: string;
  max_count?: number;
  skip?: number;
  paths?: unknown[];
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitListBranchesParams {
  environment_id: string;
  repo: string;
  include_remote?: boolean;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitListWorktreesParams {
  environment_id: string;
  repo: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitConflictsParams {
  environment_id: string;
  repo: string;
  paths?: unknown[];
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitStageParams {
  environment_id: string;
  repo: string;
  paths?: unknown[];
  hunks?: unknown[];
  context_lines?: number;
  mode?: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitUnstageParams {
  environment_id: string;
  repo: string;
  paths?: unknown[];
  hunks?: unknown[];
  context_lines?: number;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitDiscardParams {
  environment_id: string;
  repo: string;
  paths?: unknown[];
  hunks?: unknown[];
  context_lines?: number;
  confirmation_token?: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitCommitParams {
  environment_id: string;
  repo: string;
  message: string;
  amend?: boolean;
  allow_empty?: boolean;
  author?: string;
  confirmation_token?: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitCheckoutParams {
  environment_id: string;
  repo: string;
  branch: string;
  create?: boolean;
  start_point?: string;
  detach?: boolean;
  discard_changes?: boolean;
  confirmation_token?: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitResetParams {
  environment_id: string;
  repo: string;
  mode?: string;
  rev?: string;
  paths?: unknown[];
  confirmation_token?: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitFetchParams {
  environment_id: string;
  repo: string;
  remote?: string;
  refspec?: string;
  prune?: boolean;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitPullParams {
  environment_id: string;
  repo: string;
  remote?: string;
  refspec?: string;
  rebase?: boolean;
  workspace_id?: string;
  environment_generation?: number;
}
export interface GitPushParams {
  environment_id: string;
  repo: string;
  remote?: string;
  refspec?: string;
  force?: boolean;
  force_with_lease?: boolean;
  set_upstream?: boolean;
  confirmation_token?: string;
  workspace_id?: string;
  environment_generation?: number;
}
export interface ListThreadsParams {
  status?: string;
  pinned?: boolean;
  source?: string;
  model?: string;
  parent_thread_id?: string;
  created_after?: number;
  created_before?: number;
  updated_after?: number;
  updated_before?: number;
  limit?: number;
  cursor?: string;
  order?: string;
}
export interface SearchThreadsParams {
  query: string;
  status?: string;
  pinned?: boolean;
  source?: string;
  model?: string;
  parent_thread_id?: string;
  created_after?: number;
  created_before?: number;
  updated_after?: number;
  updated_before?: number;
  limit?: number;
  cursor?: string;
}
export interface UpdateThreadParams {
  thread_id: string;
  title?: string;
  pinned?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
}
export interface ListThreadDescendantsParams {
  thread_id: string;
  max_depth?: number;
  limit?: number;
}
export interface ExportThreadParams {
  thread_id: string;
  limit?: number;
  cursor?: string;
  include_descendants?: boolean;
}
export interface PurgeThreadsParams {
  retention_days: number;
  dry_run?: boolean;
}
export interface GetPlanParams {
  thread_id: string;
  scope?: string;
}
export interface GetRunDiffParams {
  thread_id: string;
  turn_id?: string;
}
export interface InitializedParams {
}
export interface RunStartedParams {
  run_id: string;
  session_id: string;
  prompt?: string;
  prompt_role?: string;
  seq?: number;
  stream_id?: string;
}
export interface RunStatusParams {
  run_id: string;
  session_id: string;
  status: string;
  message: string;
  attempt?: number;
  total?: number;
  next_delay?: number;
  seq?: number;
  stream_id?: string;
}
export interface ToolCalledParams {
  run_id: string;
  session_id: string;
  tool: string;
  input: string;
  call_id: string;
  seq?: number;
  stream_id?: string;
}
export interface ToolResultParams {
  run_id: string;
  session_id: string;
  tool: string;
  output: string;
  call_id: string;
  metadata?: Record<string, unknown>;
  seq?: number;
  stream_id?: string;
}
export interface MessageOutputParams {
  run_id: string;
  session_id: string;
  content: string;
  is_final?: boolean;
  message_id?: string;
  seq?: number;
  stream_id?: string;
}
export interface TokenParams {
  run_id: string;
  session_id: string;
  delta: Record<string, unknown>;
  totals: Record<string, unknown>;
  turn?: number;
  response_id?: string;
  model?: string;
  model_ref?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  truncation?: string;
  seq?: number;
  stream_id?: string;
}
export interface RunEndParams {
  run_id: string;
  session_id: string;
  end_reason: string;
  usage?: Record<string, unknown>;
  model?: string;
  model_ref?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  truncation?: string;
  error?: Record<string, unknown>;
  seq?: number;
  stream_id?: string;
}
export interface ToolApprovalRequestedParams {
  call_id: string;
  tool_name: string;
  arguments: string;
  metadata?: Record<string, unknown>;
  session_id?: string;
  run_id?: string;
  seq?: number;
  stream_id?: string;
}
export interface ToolApprovalResolvedParams {
  call_id: string;
  session_id?: string;
  reason?: string;
  seq?: number;
  stream_id?: string;
}
export interface McpApprovalRequestedParams {
  kind: string;
  request_id: string;
  server_label: string;
  tool_name: string;
  arguments: string;
  session_id?: string;
  run_id?: string;
  seq?: number;
  stream_id?: string;
}
export interface McpApprovalResolvedParams {
  request_id: string;
  session_id?: string;
  reason?: string;
  seq?: number;
  stream_id?: string;
}
export interface ClientRequestParams {
  request_id: string;
  function: string;
  args: Record<string, unknown>;
  session_id?: string;
  idempotency_key?: string;
  run_id?: string;
  seq?: number;
  stream_id?: string;
}
export interface ClientRequestResolvedParams {
  request_id: string;
  session_id?: string;
  reason?: string;
  seq?: number;
  stream_id?: string;
}
export interface QueueChangedParams {
  session_id: string;
  depth: number;
  items: unknown[];
  seq?: number;
  stream_id?: string;
}
export interface AccountChangedParams {
  provider: string;
  reason: string;
  account?: Record<string, unknown>;
  seq?: number;
  stream_id?: string;
}
export interface ElicitationRequestedParams {
  elicitation_id: string;
  kind: string;
  message: string;
  title?: string;
  input_schema?: Record<string, unknown>;
  options?: unknown[];
  url?: string;
  session_id?: string;
  run_id?: string;
  item_id?: string;
  source?: string;
  timeout_ms?: number;
  expires_at?: string;
  persist_response?: boolean;
  seq?: number;
  stream_id?: string;
}
export interface ElicitationResolvedParams {
  elicitation_id: string;
  status: string;
  session_id?: string;
  run_id?: string;
  action?: string;
  value?: Record<string, unknown>;
  reason?: string;
  seq?: number;
  stream_id?: string;
}
export interface McpServerStatusChangedParams {
  server_name: string;
  status: string;
  previous_status?: string;
  reason_code?: string;
  reason?: string;
  auth_state?: string;
  at?: string;
  seq?: number;
  stream_id?: string;
}
export interface SessionForkedParams {
  session_id: string;
  new_session_id: string;
  from_item_id?: string;
  seq?: number;
  stream_id?: string;
}
export interface SessionVariablesChangedParams {
  session_id: string;
  changed: unknown[];
  variables: Record<string, unknown>;
  seq?: number;
  stream_id?: string;
}
export interface FsEventsParams {
  environment_id: string;
  watch_id: string;
  events: unknown[];
  workspace_id?: string;
  environment_generation?: number;
  seq?: number;
  stream_id?: string;
}
export interface FsRescanRequiredParams {
  environment_id: string;
  watch_id: string;
  reason: string;
  workspace_id?: string;
  environment_generation?: number;
  seq?: number;
  stream_id?: string;
}
export interface FsTransferProgressParams {
  environment_id: string;
  transfer_id: string;
  direction: string;
  transferred: number;
  total: number;
  workspace_id?: string;
  environment_generation?: number;
  seq?: number;
  stream_id?: string;
}
export interface GitOperationProgressParams {
  environment_id: string;
  operation_id: string;
  repo: string;
  operation: string;
  phase: string;
  detail?: Record<string, unknown>;
  workspace_id?: string;
  environment_generation?: number;
  seq?: number;
  stream_id?: string;
}
export interface ThreadUpdatedParams {
  thread_id: string;
  changed: unknown[];
  thread: Record<string, unknown>;
  cascaded_thread_ids?: unknown[];
  seq?: number;
  stream_id?: string;
}
export interface ItemUpdatedParams {
  session_id: string;
  thread_id: string;
  item_id: string;
  kind: string;
  status: string;
  revision: number;
  item_seq: number;
  content: Record<string, unknown>;
  turn_id?: string;
  updated_at?: number;
  seq?: number;
  stream_id?: string;
}
export interface RpcMethodMap {
  "initialize": { params: InitializeParams; result: InitializeResult };
  "start_run": { params: StartRunParams; result: StartRunResult };
  "stop_run": { params: StopRunParams; result: boolean };
  "send_user_message": { params: SendUserMessageParams; result: null };
  "get_session_history": { params: GetSessionHistoryParams; result: Array<Record<string, unknown>> };
  "list_sessions": { params: ListSessionsParams; result: Array<Record<string, unknown>> };
  "archive_session": { params: ArchiveSessionParams; result: boolean };
  "delete_session": { params: DeleteSessionParams; result: boolean };
  "get_user_history": { params: GetUserHistoryParams; result: Array<Record<string, unknown>> };
  "get_agent_info": { params: GetAgentInfoParams; result: Record<string, unknown> };
  "tool_approval_response": { params: ToolApprovalResponseParams; result: boolean };
  "mcp_approval_response": { params: McpApprovalResponseParams; result: boolean };
  "client_functions": { params: ClientFunctionsParams; result: boolean };
  "client_response": { params: ClientResponseParams; result: boolean };
  "list_server_functions": { params: ListServerFunctionsParams; result: Array<Record<string, unknown>> };
  "server_call": { params: ServerCallParams; result: Record<string, unknown> };
  "enqueue_message": { params: EnqueueMessageParams; result: Record<string, unknown> };
  "list_queue": { params: ListQueueParams; result: Record<string, unknown> };
  "cancel_queued_message": { params: CancelQueuedMessageParams; result: Record<string, unknown> };
  "resume_session": { params: ResumeSessionParams; result: Record<string, unknown> };
  "ack_events": { params: AckEventsParams; result: Record<string, unknown> };
  "list_models": { params: ListModelsParams; result: Record<string, unknown> };
  "get_model": { params: GetModelParams; result: Record<string, unknown> };
  "list_providers": { params: ListProvidersParams; result: Record<string, unknown> };
  "set_session_model": { params: SetSessionModelParams; result: Record<string, unknown> };
  "set_session_reasoning": { params: SetSessionReasoningParams; result: Record<string, unknown> };
  "set_voice_model": { params: SetVoiceModelParams; result: Record<string, unknown> };
  "account_status": { params: AccountStatusParams; result: Record<string, unknown> };
  "account_login_start": { params: AccountLoginStartParams; result: Record<string, unknown> };
  "account_login_complete": { params: AccountLoginCompleteParams; result: Record<string, unknown> };
  "account_login_cancel": { params: AccountLoginCancelParams; result: boolean };
  "account_logout": { params: AccountLogoutParams; result: Record<string, unknown> };
  "account_refresh": { params: AccountRefreshParams; result: Record<string, unknown> };
  "account_usage": { params: AccountUsageParams; result: Record<string, unknown> };
  "account_select": { params: AccountSelectParams; result: Record<string, unknown> };
  "elicitation_response": { params: ElicitationResponseParams; result: Record<string, unknown> };
  "mcp_list_servers": { params: McpListServersParams; result: Record<string, unknown> };
  "mcp_get_server": { params: McpGetServerParams; result: Record<string, unknown> };
  "mcp_create_server": { params: McpCreateServerParams; result: Record<string, unknown> };
  "mcp_update_server": { params: McpUpdateServerParams; result: Record<string, unknown> };
  "mcp_delete_server": { params: McpDeleteServerParams; result: Record<string, unknown> };
  "mcp_reload_server": { params: McpReloadServerParams; result: Record<string, unknown> };
  "mcp_auth_start": { params: McpAuthStartParams; result: Record<string, unknown> };
  "mcp_auth_complete": { params: McpAuthCompleteParams; result: Record<string, unknown> };
  "mcp_auth_cancel": { params: McpAuthCancelParams; result: boolean };
  "get_thread": { params: GetThreadParams; result: Record<string, unknown> };
  "list_turns": { params: ListTurnsParams; result: Record<string, unknown> };
  "list_items": { params: ListItemsParams; result: Record<string, unknown> };
  "get_item": { params: GetItemParams; result: Record<string, unknown> };
  "agent_host_register_workspace": { params: AgentHostRegisterWorkspaceParams; result: Record<string, unknown> };
  "agent_host_register_profile": { params: AgentHostRegisterProfileParams; result: Record<string, unknown> };
  "agent_host_bind_thread": { params: AgentHostBindThreadParams; result: Record<string, unknown> };
  "agent_host_list_resources": { params: AgentHostListResourcesParams; result: Record<string, unknown> };
  "agent_host_materialize_environment": { params: AgentHostMaterializeEnvironmentParams; result: Record<string, unknown> };
  "agent_host_stop_environment": { params: AgentHostStopEnvironmentParams; result: Record<string, unknown> };
  "fork_session": { params: ForkSessionParams; result: Record<string, unknown> };
  "set_session_hold": { params: SetSessionHoldParams; result: Record<string, unknown> };
  "queue_status": { params: QueueStatusParams; result: Record<string, unknown> };
  "enqueue_notification": { params: EnqueueNotificationParams; result: Record<string, unknown> };
  "update_session_variables": { params: UpdateSessionVariablesParams; result: Record<string, unknown> };
  "set_client_status": { params: SetClientStatusParams; result: null };
  "disable_tool": { params: DisableToolParams; result: null };
  "disable_mcp_server": { params: DisableMcpServerParams; result: null };
  "report_incident": { params: ReportIncidentParams; result: null };
  "export_session": { params: ExportSessionParams; result: Record<string, unknown> };
  "get_config": { params: GetConfigParams; result: Record<string, unknown> };
  "validate_config": { params: ValidateConfigParams; result: Record<string, unknown> };
  "write_config": { params: WriteConfigParams; result: Record<string, unknown> };
  "mcp_read_resource": { params: McpReadResourceParams; result: Record<string, unknown> };
  "mcp_call_tool": { params: McpCallToolParams; result: Record<string, unknown> };
  "mcp_get_prompt": { params: McpGetPromptParams; result: Record<string, unknown> };
  "fs_watch": { params: FsWatchParams; result: Record<string, unknown> };
  "fs_unwatch": { params: FsUnwatchParams; result: boolean };
  "fs_list": { params: FsListParams; result: Record<string, unknown> };
  "fs_stat": { params: FsStatParams; result: Record<string, unknown> };
  "fs_download_open": { params: FsDownloadOpenParams; result: Record<string, unknown> };
  "fs_download_read": { params: FsDownloadReadParams; result: Record<string, unknown> };
  "fs_download_close": { params: FsDownloadCloseParams; result: boolean };
  "fs_upload_open": { params: FsUploadOpenParams; result: Record<string, unknown> };
  "fs_upload_chunk": { params: FsUploadChunkParams; result: Record<string, unknown> };
  "fs_upload_commit": { params: FsUploadCommitParams; result: Record<string, unknown> };
  "fs_upload_abort": { params: FsUploadAbortParams; result: boolean };
  "git_list_repositories": { params: GitListRepositoriesParams; result: Record<string, unknown> };
  "git_status": { params: GitStatusParams; result: Record<string, unknown> };
  "git_diff": { params: GitDiffParams; result: Record<string, unknown> };
  "git_log": { params: GitLogParams; result: Record<string, unknown> };
  "git_list_branches": { params: GitListBranchesParams; result: Record<string, unknown> };
  "git_list_worktrees": { params: GitListWorktreesParams; result: Record<string, unknown> };
  "git_conflicts": { params: GitConflictsParams; result: Record<string, unknown> };
  "git_stage": { params: GitStageParams; result: Record<string, unknown> };
  "git_unstage": { params: GitUnstageParams; result: Record<string, unknown> };
  "git_discard": { params: GitDiscardParams; result: Record<string, unknown> };
  "git_commit": { params: GitCommitParams; result: Record<string, unknown> };
  "git_checkout": { params: GitCheckoutParams; result: Record<string, unknown> };
  "git_reset": { params: GitResetParams; result: Record<string, unknown> };
  "git_fetch": { params: GitFetchParams; result: Record<string, unknown> };
  "git_pull": { params: GitPullParams; result: Record<string, unknown> };
  "git_push": { params: GitPushParams; result: Record<string, unknown> };
  "list_threads": { params: ListThreadsParams; result: Record<string, unknown> };
  "search_threads": { params: SearchThreadsParams; result: Record<string, unknown> };
  "update_thread": { params: UpdateThreadParams; result: Record<string, unknown> };
  "list_thread_descendants": { params: ListThreadDescendantsParams; result: Record<string, unknown> };
  "export_thread": { params: ExportThreadParams; result: Record<string, unknown> };
  "purge_threads": { params: PurgeThreadsParams; result: Record<string, unknown> };
  "get_plan": { params: GetPlanParams; result: Record<string, unknown> };
  "get_run_diff": { params: GetRunDiffParams; result: Record<string, unknown> };
}
export interface RpcNotificationMap {
  "run_started": RunStartedParams;
  "run_status": RunStatusParams;
  "tool_called": ToolCalledParams;
  "tool_result": ToolResultParams;
  "message_output": MessageOutputParams;
  "token": TokenParams;
  "run_end": RunEndParams;
  "tool_approval_requested": ToolApprovalRequestedParams;
  "tool_approval_resolved": ToolApprovalResolvedParams;
  "mcp_approval_requested": McpApprovalRequestedParams;
  "mcp_approval_resolved": McpApprovalResolvedParams;
  "client_request": ClientRequestParams;
  "client_request_resolved": ClientRequestResolvedParams;
  "queue_changed": QueueChangedParams;
  "account_changed": AccountChangedParams;
  "elicitation_requested": ElicitationRequestedParams;
  "elicitation_resolved": ElicitationResolvedParams;
  "mcp_server_status_changed": McpServerStatusChangedParams;
  "session_forked": SessionForkedParams;
  "session_variables_changed": SessionVariablesChangedParams;
  "fs_events": FsEventsParams;
  "fs_rescan_required": FsRescanRequiredParams;
  "fs_transfer_progress": FsTransferProgressParams;
  "git_operation_progress": GitOperationProgressParams;
  "thread_updated": ThreadUpdatedParams;
  "item_updated": ItemUpdatedParams;
}
export interface RpcClientNotificationMap {
  "initialized": InitializedParams;
}
export type RpcRequest<M extends keyof RpcMethodMap = keyof RpcMethodMap> = {
  [K in M]: { jsonrpc: '2.0'; id: JsonRpcId; method: K; params: RpcMethodMap[K]['params'] }
}[M];
export type RpcNotification<E extends keyof RpcNotificationMap = keyof RpcNotificationMap> = {
  [K in E]: { jsonrpc: '2.0'; method: K; params: RpcNotificationMap[K] }
}[E];
export type RpcClientNotification<E extends keyof RpcClientNotificationMap = keyof RpcClientNotificationMap> = {
  [K in E]: { jsonrpc: '2.0'; method: K; params: RpcClientNotificationMap[K] }
}[E];
