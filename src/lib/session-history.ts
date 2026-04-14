/**
 * Pure session-history parser.
 *
 * Extracted from ProjectManager (Sprint C1 of the project-manager
 * decomposition). The sqlite3 query side-effect stays in ProjectManager;
 * the JSON-row → SessionMessage shaping lives here so it's unit-testable.
 */
import type { SessionMessage } from '@/shared/types';

export interface HistoryRow {
  id: number;
  msg_json: string;
  created_at: string;
}

const USER_CONTENT_LIMIT = 50_000;
const ASSISTANT_CONTENT_LIMIT = 50_000;
const TOOL_CALL_ARGS_LIMIT = 2_000;
const TOOL_RESULT_LIMIT = 5_000;

export function parseSessionHistoryRows(rows: HistoryRow[]): SessionMessage[] {
  const messages: SessionMessage[] = [];

  for (const row of rows) {
    try {
      const msg = JSON.parse(row.msg_json) as Record<string, unknown>;
      const msgType = msg.type as string | undefined;
      const role = msg.role as string | undefined;

      // Skip reasoning blocks (encrypted, not useful)
      if (msgType === 'reasoning') {
        continue;
      }

      if (role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        messages.push({
          id: row.id,
          role: 'user',
          content: content.slice(0, USER_CONTENT_LIMIT),
          createdAt: row.created_at,
        });
      } else if (role === 'assistant' && msgType === 'message') {
        const contentBlocks = msg.content as Array<{ type: string; text?: string }> | undefined;
        const text = Array.isArray(contentBlocks)
          ? contentBlocks
              .filter((b) => b.type === 'text' && b.text)
              .map((b) => b.text)
              .join('\n')
          : '';
        if (text) {
          messages.push({
            id: row.id,
            role: 'assistant',
            content: text.slice(0, ASSISTANT_CONTENT_LIMIT),
            createdAt: row.created_at,
          });
        }
      } else if (msgType === 'function_call') {
        const name = (msg.name as string) || 'unknown_tool';
        const args = typeof msg.arguments === 'string' ? msg.arguments : JSON.stringify(msg.arguments ?? '');
        messages.push({
          id: row.id,
          role: 'tool_call',
          content: args.slice(0, TOOL_CALL_ARGS_LIMIT),
          toolName: name,
          createdAt: row.created_at,
        });
      } else if (msgType === 'function_call_output') {
        const output = typeof msg.output === 'string' ? msg.output : JSON.stringify(msg.output ?? '');
        messages.push({
          id: row.id,
          role: 'tool_result',
          content: output.slice(0, TOOL_RESULT_LIMIT),
          createdAt: row.created_at,
        });
      }
    } catch {
      // Skip unparseable messages
    }
  }

  return messages;
}
