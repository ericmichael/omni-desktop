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

export type ChatMessage = {
  type: 'chat';
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  attachments?: Attachment[];
};

export type ToolItem = {
  type: 'tool';
  call_id?: string;
  tool: string;
  input?: string;
  output?: string;
  status: 'called' | 'result';
  metadata?: any;
  runId?: string;
};

export type ApprovalItem = {
  type: 'approval';
  request_id: string;
  tool: string;
  argumentsText?: string;
  metadata?: any;
  session_id?: string;
};

export type PlanStep = {
  title: string;
  description?: string;
};

export type PlanItem = {
  type: 'plan';
  id: string;
  title: string;
  description?: string;
  steps: PlanStep[];
};

export type ArtifactItem = {
  type: 'artifact';
  artifact_id?: string;
  title: string;
  content: string;
  mode?: string;
  session_id?: string;
  updated_at?: number;
};

export type MessageItem = ChatMessage | ToolItem | ApprovalItem | ArtifactItem;

// ---------------------------------------------------------------------------
// Preamble buffer
// ---------------------------------------------------------------------------

export type PreambleChunk = {
  content: string;
  timestamp: number;
  superseded: boolean;
};
