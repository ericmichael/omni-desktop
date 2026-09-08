import type { ArtifactItem } from '@/shared/chat-types';

/** One projection for live tool results and persisted tool items. The surface
 * belongs to an invocation, not a provider call ID reused in a later run. */
export function mcpArtifact(input: {
  sessionId?: string;
  runId?: string;
  callId?: string;
  tool: string;
  output?: string;
  metadata?: any;
}): ArtifactItem | undefined {
  const ui = input.metadata?.mcp_ui;
  const hasResourceUri = typeof ui?.resource_uri === 'string' && ui.resource_uri.length > 0;
  if (!ui || (ui.resource == null && !hasResourceUri)) {
    return undefined;
  }
  return {
    type: 'artifact',
    artifact_id: `mcp_ui:${JSON.stringify([input.sessionId ?? '', input.runId ?? '', input.callId || input.tool])}`,
    title: ui.tool_name || input.tool || 'MCP App',
    content: '',
    mode: 'mcp_ui',
    session_id: input.sessionId,
    mcp_ui: {
      server_name: String(ui.server_name ?? ''),
      tool_name: String(ui.tool_name ?? input.tool),
      tool_input: undefined,
      tool_output: input.output,
      resource: ui.resource,
      resource_uri: hasResourceUri ? ui.resource_uri : undefined,
      structured_content: ui.structured_content,
    },
  };
}
