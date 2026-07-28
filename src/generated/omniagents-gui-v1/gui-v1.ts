export type JsonRpcId = string | number;
export type JsonRpcError = { code: number; message: string; data?: unknown };
export interface StartRunParams {
  prompt: string;
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
export interface ForkSessionParams {
  session_id: string;
  new_session_id?: string;
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
export interface RunStartedParams {
  run_id: string;
  session_id: string;
  prompt?: string;
  prompt_role?: string;
}
export interface RunStatusParams {
  run_id: string;
  session_id: string;
  status: string;
  message: string;
  attempt?: number;
  total?: number;
  next_delay?: number;
}
export interface ToolCalledParams {
  run_id: string;
  session_id: string;
  tool: string;
  input: string;
  call_id: string;
}
export interface ToolResultParams {
  run_id: string;
  session_id: string;
  tool: string;
  output: string;
  call_id: string;
  metadata?: Record<string, unknown>;
}
export interface MessageOutputParams {
  run_id: string;
  session_id: string;
  content: string;
}
export interface TokenParams {
  run_id: string;
  session_id: string;
  delta: Record<string, unknown>;
  totals: Record<string, unknown>;
  turn?: number;
  response_id?: string;
  model?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  truncation?: string;
}
export interface RunEndParams {
  run_id: string;
  session_id: string;
  end_reason: string;
  usage?: Record<string, unknown>;
  model?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  truncation?: string;
  error?: Record<string, unknown>;
}
export interface ToolApprovalRequestedParams {
  call_id: string;
  tool_name: string;
  arguments: string;
  metadata?: Record<string, unknown>;
  session_id?: string;
  run_id?: string;
}
export interface ToolApprovalResolvedParams {
  call_id: string;
  session_id?: string;
}
export interface McpApprovalRequestedParams {
  kind: string;
  request_id: string;
  server_label: string;
  tool_name: string;
  arguments: string;
  session_id?: string;
  run_id?: string;
}
export interface McpApprovalResolvedParams {
  request_id: string;
  session_id?: string;
}
export interface ClientRequestParams {
  request_id: string;
  function: string;
  args: Record<string, unknown>;
  session_id?: string;
  idempotency_key?: string;
  run_id?: string;
}
export interface ClientRequestResolvedParams {
  request_id: string;
}
export interface QueueChangedParams {
  session_id: string;
  depth: number;
  items: unknown[];
}
export interface SessionForkedParams {
  session_id: string;
  new_session_id: string;
}
export interface SessionVariablesChangedParams {
  session_id: string;
  changed: Record<string, unknown>;
  variables: Record<string, unknown>;
}
export interface RpcMethodMap {
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
  "session_forked": SessionForkedParams;
  "session_variables_changed": SessionVariablesChangedParams;
}
export type RpcRequest<M extends keyof RpcMethodMap = keyof RpcMethodMap> = {
  [K in M]: { jsonrpc: '2.0'; id: JsonRpcId; method: K; params: RpcMethodMap[K]['params'] }
}[M];
export type RpcNotification<E extends keyof RpcNotificationMap = keyof RpcNotificationMap> = {
  [K in E]: { jsonrpc: '2.0'; method: K; params: RpcNotificationMap[K] }
}[E];
