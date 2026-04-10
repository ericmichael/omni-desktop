/**
 * Pure function that converts raw session history (from omniagents RPC)
 * into the MessageItem[] format used by the UI.
 *
 * Extracted from App.tsx handleSelectSession so it can be unit-tested.
 */

export type ChatMessage = {
  type: 'chat';
  role: string;
  content: string;
  timestamp?: string;
  attachments?: Array<{ type: 'image' | 'file'; url?: string; filename?: string; mime?: string; size?: number }>;
};

export type ToolItem = {
  type: 'tool';
  tool: string;
  input?: string;
  call_id: string;
  output?: string;
  status: 'called' | 'result';
  metadata?: unknown;
};

export type RehydratedItem = ChatMessage | ToolItem;

/**
 * Parse raw history items returned by `get_session_history` into UI items.
 *
 * History items come in several shapes:
 *   - `{role: "user", content: "..."}` — user messages
 *   - `{type: "message", role: "assistant", content: [{type: "output_text", text: "..."}]}` — assistant messages
 *   - `{type: "function_call", call_id, name, arguments}` — tool calls
 *   - `{type: "function_call_output", call_id, output}` — tool results
 *   - `{type: "reasoning", ...}` — reasoning (skipped)
 */
export function rehydrateHistory(history: Record<string, unknown>[]): RehydratedItem[] {
  const msgs: RehydratedItem[] = [];
  const callIndex: Record<string, number> = {};

  for (const item of history) {
    const t = String((item && item.type) || '');

    // Tool call (function_call, computer_call, etc.)
    if (t && t.endsWith('_call') && !t.endsWith('_call_output')) {
      const tool = String(item.name || '');
      let input = '';
      try {
        if (typeof item.arguments === 'string') {
          input = item.arguments;
        } else if (item.arguments !== null && item.arguments !== undefined) {
          input = JSON.stringify(item.arguments);
        }
      } catch {
        input = String(item.arguments || '');
      }
      const call_id = String(item.call_id || '');
      const idx = msgs.length;
      msgs.push({ type: 'tool', tool, input, call_id, status: 'called' });
      if (call_id) {
        callIndex[call_id] = idx;
      }
      continue;
    }

    // Tool result (function_call_output, etc.)
    if (t && t.endsWith('_call_output')) {
      const call_id = String(item.call_id || '');
      const tool = String(item.name || '');
      let output = '';
      try {
        output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
      } catch {
        output = String(item.output || '');
      }
      const metadata = item.metadata;
      const existing = call_id && callIndex[call_id] !== undefined ? callIndex[call_id] : -1;
      if (existing >= 0) {
        const prev = msgs[existing] as ToolItem;
        msgs[existing] = { ...prev, output, status: 'result', metadata };
      } else {
        msgs.push({ type: 'tool', tool, output, call_id, status: 'result', metadata });
      }
      continue;
    }

    // Chat message (user or assistant)
    if (item && item.role) {
      const role = String(item.role);
      let content = '';
      let attachments: ChatMessage['attachments'] = [];

      if (typeof item.content === 'string') {
        content = item.content;
      } else if (Array.isArray(item.content)) {
        const parts = item.content as Record<string, unknown>[];
        if (role === 'assistant') {
          const textParts = parts
            .filter((p) => p && (p.type === 'output_text' || p.type === 'text'))
            .map((p) => String(p.text || ''));
          content = textParts.join('\n');
        } else {
          const textParts = parts
            .filter((p) => p && (p.type === 'input_text' || p.type === 'text'))
            .map((p) => String(p.text || p.input_text || ''));
          content = textParts.join('\n');
          for (const p of parts) {
            if (p && p.type === 'input_image' && p.image_url) {
              attachments.push({ type: 'image', url: String(p.image_url), filename: p.filename as string });
            } else if (p && p.type === 'input_file') {
              attachments.push({ type: 'file', filename: p.filename as string });
            }
          }
        }
      } else if (item.content && typeof item.content === 'object') {
        const obj = item.content as Record<string, unknown>;
        content = String(obj.text || obj.input_text || '');
        if (!content) {
          try {
            content = JSON.stringify(item.content);
          } catch {
            content = String(item.content);
          }
        }
      }

      msgs.push({ type: 'chat', role, content, timestamp: item.timestamp as string, attachments });
      continue;
    }
  }

  return msgs;
}
