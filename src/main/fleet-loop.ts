import fs from 'fs/promises';
import path from 'path';

import type { FleetTaskId, FleetTicketLoopStatus } from '@/shared/types';

type RunEndReason = 'completed' | 'cancelled' | 'max_turns' | 'error' | string;

/**
 * Sentinel values the agent can output to signal task-level status.
 * These are distinct from `end_reason` which only tells us the *run* finished.
 */
const SENTINEL_COMPLETE = 'STATUS: COMPLETE';
const SENTINEL_BLOCKED = 'STATUS: BLOCKED';

type TaskSignal = 'complete' | 'blocked' | 'continue';

type FleetLoopCallbacks = {
  onIterationStart: (iteration: number) => { taskId: FleetTaskId };
  onIterationEnd: (taskId: FleetTaskId, endReason: RunEndReason) => void;
  onSessionStart: (taskId: FleetTaskId, sessionId: string) => void;
  onLoopComplete: () => void;
  onLoopError: (error: Error) => void;
  onLoopBlocked: () => void;
  onStatusChange: (status: FleetTicketLoopStatus, iteration: number) => void;
};

type FleetLoopControllerOpts = {
  wsUrl: string;
  workspaceDir: string;
  ticketTitle: string;
  ticketDescription: string;
  maxIterations: number;
  maxNudges?: number;
  startFromIteration?: number;
  callbacks: FleetLoopCallbacks;
};

const BETWEEN_ITERATION_DELAY_MS = 2_000;
const HISTORY_QUERY_TIMEOUT_MS = 5_000;
const MAX_NUDGES_DEFAULT = 3;

const NUDGE_PROMPT = `You did not output a completion signal. You MUST end your response with exactly one of these on its own line:
- \`${SENTINEL_COMPLETE}\` — if the task is fully complete.
- \`${SENTINEL_BLOCKED}\` — if you are blocked and need human intervention.
If there is still more work to do, say what remains and do NOT output either sentinel.
Output your signal now.`;

const buildPrompt = (opts: { iteration: number; ticketTitle: string; ticketDescription: string }): string => {
  const sentinelInstructions = `
## CRITICAL: Completion Signals
Your FINAL message MUST end with exactly one of these sentinels on its own line:
- \`${SENTINEL_COMPLETE}\` — the task is fully complete, all requirements met, quality checks pass.
- \`${SENTINEL_BLOCKED}\` — you are blocked and need human intervention (missing credentials, unclear requirements, external dependency).
If the task is not yet complete and you are not blocked, do NOT output either sentinel — just end your message normally and another iteration will continue your work.
You MUST output a sentinel if the task is complete. Do not forget.`;

  if (opts.iteration === 1) {
    return `You are working on the following task autonomously. This is iteration 1.

## Task
Title: ${opts.ticketTitle}
Description: ${opts.ticketDescription}

## Instructions
- Work autonomously. Do NOT ask questions or seek confirmation — just proceed.
- Do NOT narrate what you're about to do. Just do it.
- If a progress.txt file exists in the workspace root, read it for context from previous iterations.
- Before finishing, append a brief summary of what you accomplished to progress.txt.
- Make incremental progress. It's fine to not finish everything — another iteration will continue.
- Run quality checks (typecheck, lint, tests) before committing.
${sentinelInstructions}`;
  }

  return `Continue working on the task. This is iteration ${opts.iteration}.
Read progress.txt for context on what's been accomplished so far.
Do not ask questions. Do not narrate. Just proceed with implementation.
${sentinelInstructions}`;
};

/**
 * Extract text from a history item's content field.
 *
 * The OpenAI Responses API stores message items as:
 *   { role: "assistant", type: "message", content: [{type: "output_text", text: "..."}], ... }
 *
 * Simple user messages may be stored as:
 *   { role: "user", content: "plain string" }
 */
const extractText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === 'string') {
          return block;
        }
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text: unknown }).text);
        }
        return '';
      })
      .join('\n');
  }
  return '';
};

/**
 * Scan history for sentinel values. History items include:
 * - {role: "assistant", type: "message", content: [{type: "output_text", text: "..."}]}
 * - {type: "function_call", name, arguments, ...}
 * - {type: "function_call_output", output, ...}
 *
 * We scan ALL assistant messages because tool calls/outputs may appear after the
 * final text message containing the sentinel.
 */
const detectSignal = (history: Array<Record<string, unknown>>): TaskSignal => {
  // Log the last few items for debugging
  const lastItems = history.slice(-5).map((item, i) => {
    const idx = history.length - 5 + i;
    const text = extractText(item.content);
    const preview = text ? `"...${text.slice(-100)}"` : 'N/A';
    return `[${idx}] role=${item.role as string | undefined} type=${item.type as string | undefined} text=${preview}`;
  });
  console.log(`[FleetLoop] Last 5 history items:\n${lastItems.join('\n')}`);

  // Scan backwards through all assistant messages for sentinels
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role === 'assistant') {
      const text = extractText(msg.content);
      if (!text) {
        continue;
      }
      if (text.includes(SENTINEL_COMPLETE)) {
        console.log(`[FleetLoop] Found COMPLETE sentinel in message [${i}]`);
        return 'complete';
      }
      if (text.includes(SENTINEL_BLOCKED)) {
        console.log(`[FleetLoop] Found BLOCKED sentinel in message [${i}]`);
        return 'blocked';
      }
    }
  }
  return 'continue';
};

export class FleetLoopController {
  private ws: WebSocket | null = null;
  private iteration = 0;
  private maxIterations: number;
  private maxNudges: number;
  private startFromIteration: number;
  private status: FleetTicketLoopStatus | 'idle' = 'idle';
  private currentTaskId: FleetTaskId | null = null;
  private currentSessionId: string | null = null;
  private iterationStartTime = 0;
  private stopped = false;
  /** Guards against decideNextStep being called twice (timeout + response race). */
  private pendingDecision = false;
  /** How many nudges we've sent in the current iteration. */
  private nudgeCount = 0;

  wsUrl: string;
  private workspaceDir: string;
  private ticketTitle: string;
  private ticketDescription: string;
  private callbacks: FleetLoopCallbacks;

  constructor(opts: FleetLoopControllerOpts) {
    this.wsUrl = opts.wsUrl;
    this.workspaceDir = opts.workspaceDir;
    this.ticketTitle = opts.ticketTitle;
    this.ticketDescription = opts.ticketDescription;
    this.maxIterations = opts.maxIterations;
    this.maxNudges = opts.maxNudges ?? MAX_NUDGES_DEFAULT;
    this.startFromIteration = opts.startFromIteration ?? 1;
    this.callbacks = opts.callbacks;
  }

  start(): void {
    if (this.status !== 'idle') {
      console.log(`[FleetLoop] start() called but status is ${this.status}, ignoring`);
      return;
    }
    this.stopped = false;
    this.iteration = this.startFromIteration;
    console.log(`[FleetLoop] Starting loop from iteration ${this.iteration}, max ${this.maxIterations}, wsUrl=${this.wsUrl}`);
    this.setStatus('running');
    this.startIteration();
  }

  stop(): void {
    console.log(`[FleetLoop] stop() called, iteration=${this.iteration}`);
    this.stopped = true;
    this.setStatus('stopped');
    this.closeWs();
    if (this.currentTaskId) {
      this.callbacks.onIterationEnd(this.currentTaskId, 'cancelled');
    }
  }

  getStatus(): FleetTicketLoopStatus | 'idle' {
    return this.status;
  }

  getIteration(): number {
    return this.iteration;
  }

  getMaxIterations(): number {
    return this.maxIterations;
  }

  private setStatus(status: FleetTicketLoopStatus): void {
    this.status = status;
    this.callbacks.onStatusChange(status, this.iteration);
  }

  private startIteration(): void {
    if (this.stopped) {
      console.log(`[FleetLoop] startIteration() called but stopped, ignoring`);
      return;
    }

    console.log(`[FleetLoop] Starting iteration ${this.iteration}`);
    this.iterationStartTime = Date.now();
    this.currentSessionId = null;
    this.pendingDecision = false;
    this.nudgeCount = 0;
    const { taskId } = this.callbacks.onIterationStart(this.iteration);
    this.currentTaskId = taskId;
    console.log(`[FleetLoop] Iteration ${this.iteration} → taskId=${taskId}`);

    const prompt = buildPrompt({
      iteration: this.iteration,
      ticketTitle: this.ticketTitle,
      ticketDescription: this.ticketDescription,
    });

    this.connectAndSendRun(prompt);
  }

  /**
   * Send a nudge in the SAME session — a lightweight start_run that asks the agent
   * to output a sentinel. This reuses the existing WS connection and session.
   */
  private sendNudge(): void {
    if (this.stopped || !this.currentSessionId) {
      return;
    }

    this.nudgeCount++;
    console.log(`[FleetLoop] Sending nudge ${this.nudgeCount}/${this.maxNudges} in session ${this.currentSessionId}`);
    this.pendingDecision = false;

    // We need a fresh WS connection for the nudge run
    this.connectAndSendRun(NUDGE_PROMPT, this.currentSessionId);
  }

  /**
   * Connect to WS and send start_run. If sessionId is provided, continues that session (nudge).
   * If not, creates a fresh session (new iteration).
   */
  private connectAndSendRun(prompt: string, sessionId?: string): void {
    this.closeWs();

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    let settled = false;

    const rpcId = sessionId ? `nudge-${this.iteration}-${this.nudgeCount}` : `loop-${this.iteration}`;

    ws.addEventListener('open', () => {
      if (this.stopped) {
        console.log(`[FleetLoop] WS opened but stopped, closing`);
        ws.close();
        return;
      }
      const params: Record<string, string> = { prompt };
      if (sessionId) {
        params.session_id = sessionId;
      }
      console.log(`[FleetLoop] WS connected, sending start_run (${sessionId ? `nudge ${this.nudgeCount}` : `iteration ${this.iteration}`})`);
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId,
          method: 'start_run',
          params,
        })
      );
    });

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as {
          id?: string;
          method?: string;
          result?: unknown;
          error?: { message?: string };
          params?: { end_reason?: string; run_id?: string };
        };

        // Handle start_run response
        if (data.id === rpcId && !settled) {
          settled = true;
          if (data.error) {
            console.log(`[FleetLoop] start_run error: ${data.error.message}`);
            this.handleError(new Error(data.error.message ?? 'start_run RPC error'));
            return;
          }
          const result = data.result as { session_id?: string } | undefined;
          console.log(`[FleetLoop] start_run success, session_id=${result?.session_id}`);
          if (result?.session_id && !sessionId) {
            // Only set session on first run, not nudges
            this.currentSessionId = result.session_id;
            if (this.currentTaskId) {
              this.callbacks.onSessionStart(this.currentTaskId, result.session_id);
            }
          }
        }

        // Handle get_session_history response
        if (data.id?.startsWith('history-')) {
          console.log(`[FleetLoop] Received history response, isArray=${Array.isArray(data.result)}, length=${Array.isArray(data.result) ? data.result.length : 'N/A'}`);
          if (Array.isArray(data.result)) {
            this.handleHistoryResponse(data.result as Array<Record<string, unknown>>);
          } else {
            console.log(`[FleetLoop] History response not an array, defaulting to continue. data.error=${JSON.stringify(data.error)}`);
            this.decideNextStep('continue');
          }
        }

        // Handle run_end notification
        if (data.method === 'run_end' && data.params) {
          const endReason = data.params.end_reason ?? 'completed';
          console.log(`[FleetLoop] run_end received: endReason=${endReason}, iteration=${this.iteration}, nudgeCount=${this.nudgeCount}`);
          this.handleRunEnd(endReason);
        }
      } catch {
        // Ignore unparseable messages
      }
    });

    ws.addEventListener('error', (err) => {
      console.log(`[FleetLoop] WS error: ${(err as ErrorEvent).message ?? 'unknown'}, settled=${settled}, pendingDecision=${this.pendingDecision}`);
      if (!settled) {
        settled = true;
        setTimeout(() => {
          if (!this.stopped) {
            console.log(`[FleetLoop] Retrying WS connection after error`);
            this.connectAndSendRun(prompt, sessionId);
          }
        }, 2_000);
      } else if (!this.pendingDecision) {
        this.handleError(new Error(`WebSocket error: ${(err as ErrorEvent).message ?? 'unknown'}`));
      }
    });

    ws.addEventListener('close', () => {
      console.log(`[FleetLoop] WS closed, settled=${settled}, stopped=${this.stopped}, pendingDecision=${this.pendingDecision}`);
      if (!settled && !this.stopped) {
        settled = true;
        setTimeout(() => {
          if (!this.stopped) {
            console.log(`[FleetLoop] Retrying WS connection after close`);
            this.connectAndSendRun(prompt, sessionId);
          }
        }, 2_000);
      } else if (this.pendingDecision) {
        console.log(`[FleetLoop] WS closed while pendingDecision, defaulting to continue`);
        this.decideNextStep('continue');
      }
    });
  }

  /**
   * Called when run_end fires. Query history for sentinels before deciding next step.
   */
  private handleRunEnd(endReason: string): void {
    console.log(`[FleetLoop] handleRunEnd: endReason=${endReason}, stopped=${this.stopped}, currentTaskId=${this.currentTaskId}, sessionId=${this.currentSessionId}`);
    if (this.stopped || !this.currentTaskId) {
      return;
    }

    // Hard errors — don't bother checking history
    if (endReason === 'error' || endReason === 'guardrail_violation') {
      this.callbacks.onIterationEnd(this.currentTaskId, endReason);
      void this.appendProgress(this.iteration, endReason);
      this.closeWs();
      this.setStatus('error');
      this.callbacks.onLoopError(new Error(`Agent ended with ${endReason} at iteration ${this.iteration}`));
      return;
    }

    if (endReason === 'cancelled') {
      this.callbacks.onIterationEnd(this.currentTaskId, endReason);
      void this.appendProgress(this.iteration, endReason);
      this.closeWs();
      this.setStatus('stopped');
      return;
    }

    // For normal completions, query session history to check for sentinels.
    this.pendingDecision = true;

    const historyId = `history-${this.iteration}-${this.nudgeCount}`;
    if (this.currentSessionId && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: historyId,
          method: 'get_session_history',
          params: { session_id: this.currentSessionId },
        })
      );

      // Fallback timeout
      setTimeout(() => {
        if (this.pendingDecision && !this.stopped) {
          console.log(`[FleetLoop] History query timed out, defaulting to continue`);
          this.decideNextStep('continue');
        }
      }, HISTORY_QUERY_TIMEOUT_MS);
    } else {
      this.decideNextStep('continue');
    }
  }

  private handleHistoryResponse(history: Array<Record<string, unknown>>): void {
    if (this.stopped || !this.pendingDecision) {
      console.log(`[FleetLoop] handleHistoryResponse: stopped=${this.stopped}, pendingDecision=${this.pendingDecision}, ignoring`);
      return;
    }
    const signal = detectSignal(history);
    console.log(`[FleetLoop] Signal detected from history: ${signal}`);
    this.decideNextStep(signal);
  }

  /**
   * Central decision point after each run_end + history check.
   * If no sentinel found and we haven't exhausted nudges, nudge instead of new iteration.
   */
  private decideNextStep(signal: TaskSignal): void {
    if (!this.pendingDecision) {
      console.log(`[FleetLoop] decideNextStep called but no pendingDecision, ignoring`);
      return;
    }
    this.pendingDecision = false;

    console.log(`[FleetLoop] decideNextStep: signal=${signal}, iteration=${this.iteration}/${this.maxIterations}, nudges=${this.nudgeCount}/${this.maxNudges}`);

    if (signal === 'complete') {
      this.endIteration(signal);
      console.log(`[FleetLoop] Task signaled COMPLETE, finishing loop`);
      this.setStatus('completed');
      this.callbacks.onLoopComplete();
      return;
    }

    if (signal === 'blocked') {
      this.endIteration(signal);
      console.log(`[FleetLoop] Task signaled BLOCKED, stopping loop`);
      this.setStatus('stopped');
      this.callbacks.onLoopBlocked();
      return;
    }

    // signal === 'continue' — no sentinel found
    // Try nudging in the same session before moving to a new iteration
    if (this.nudgeCount < this.maxNudges) {
      console.log(`[FleetLoop] No sentinel found, nudging (${this.nudgeCount + 1}/${this.maxNudges})`);
      this.sendNudge();
      return;
    }

    // Exhausted nudges — end this iteration and move to next
    console.log(`[FleetLoop] No sentinel after ${this.maxNudges} nudges, moving to next iteration`);
    this.endIteration(signal);

    if (this.iteration >= this.maxIterations) {
      console.log(`[FleetLoop] Max iterations reached (${this.maxIterations}), finishing loop`);
      this.setStatus('completed');
      this.callbacks.onLoopComplete();
      return;
    }

    // Next iteration after a small delay
    this.iteration++;
    console.log(`[FleetLoop] Continuing to iteration ${this.iteration} after ${BETWEEN_ITERATION_DELAY_MS}ms delay`);
    this.setStatus('running');
    setTimeout(() => {
      if (!this.stopped) {
        this.startIteration();
      }
    }, BETWEEN_ITERATION_DELAY_MS);
  }

  /** Mark current iteration task as ended and write progress. */
  private endIteration(signal: TaskSignal): void {
    if (this.currentTaskId) {
      const duration = Math.round((Date.now() - this.iterationStartTime) / 1000);
      console.log(`[FleetLoop] Ending iteration ${this.iteration}, taskId=${this.currentTaskId}, duration=${duration}s, signal=${signal}, nudges=${this.nudgeCount}`);
      this.callbacks.onIterationEnd(this.currentTaskId, 'completed');
      void this.appendProgress(this.iteration, `completed (signal: ${signal}, nudges: ${this.nudgeCount})`, duration);
    }
    this.closeWs();
  }

  private handleError(error: Error): void {
    if (this.stopped) {
      return;
    }
    this.setStatus('error');
    this.closeWs();
    this.callbacks.onLoopError(error);
  }

  private closeWs(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  private async appendProgress(iteration: number, endReason: string, duration?: number): Promise<void> {
    const progressPath = path.join(this.workspaceDir, 'progress.txt');
    const timestamp = new Date().toISOString();
    const durationStr = duration !== undefined ? `\n- Duration: ${duration}s` : '';

    let content: string;
    if (iteration === 1) {
      content = `# Task Progress
Ticket: ${this.ticketTitle}
Started: ${timestamp}
---

## Iteration ${iteration} — ${timestamp}
- End reason: ${endReason}${durationStr}
---

`;
    } else {
      content = `## Iteration ${iteration} — ${timestamp}
- End reason: ${endReason}${durationStr}
---

`;
    }

    try {
      await fs.appendFile(progressPath, content, 'utf8');
    } catch (error) {
      console.warn(`Failed to write progress.txt: ${(error as Error).message}`);
    }
  }
}
