/**
 * Local type definitions for AI UI components.
 * Decoupled from Vercel AI SDK — defines only the types our components actually use.
 */

// ── Tool state machine ──────────────────────────────────────────────

export type ToolState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied'

// ── Chat status ─────────────────────────────────────────────────────

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

// ── Message parts ───────────────────────────────────────────────────

export interface TextUIPart {
  type: 'text'
  text: string
}

export interface ReasoningUIPart {
  type: 'reasoning'
  reasoning: string
  details: Array<{ type: 'text'; text: string } | { type: 'redacted' }>
}

export interface ToolUIPart {
  type: `tool-${string}`
  toolCallId: string
  state: ToolState
  input: unknown
  output?: unknown
  errorText?: string
  approval?: { state: 'requested' | 'approved' | 'denied'; message?: string }
}

export interface DynamicToolUIPart {
  type: 'dynamic-tool'
  toolName: string
  toolCallId: string
  state: ToolState
  input: unknown
  output?: unknown
  errorText?: string
  approval?: { state: 'requested' | 'approved' | 'denied'; message?: string }
}

export interface FileUIPart {
  type: 'file'
  mediaType: string
  filename?: string
  url: string
}

export interface SourceDocumentUIPart {
  type: 'source-document'
  sourceId: string
  mediaType: string
  title: string
  filename?: string
}

export interface SourceUIPart {
  type: 'source'
  source: {
    sourceType: 'url'
    id: string
    url: string
    title?: string
    providerMetadata?: Record<string, unknown>
  }
}

export interface StepStartUIPart {
  type: 'step-start'
}

// ── Union of all message part types ─────────────────────────────────

export type UIMessagePart =
  | TextUIPart
  | ReasoningUIPart
  | ToolUIPart
  | DynamicToolUIPart
  | FileUIPart
  | SourceDocumentUIPart
  | SourceUIPart
  | StepStartUIPart

// ── Message ─────────────────────────────────────────────────────────

export interface UIMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  parts: UIMessagePart[]
  metadata?: unknown
}

// ── Usage ───────────────────────────────────────────────────────────

export interface LanguageModelUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  totalTokens?: number
}

// ── Tool definition ─────────────────────────────────────────────────

export interface Tool {
  description?: string
  inputSchema?: Record<string, unknown>
}
