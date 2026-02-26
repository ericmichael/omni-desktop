import fs from 'fs/promises';
import path from 'path';

import type { FleetSentinel, FleetTaskId, FleetTicketLoopStatus } from '@/shared/types';

type RunEndReason = 'completed' | 'cancelled' | 'max_turns' | 'error' | string;

// #region Signal detection

/**
 * Result of scanning history for a sentinel.
 */
export type DetectedSignal = { type: 'sentinel'; sentinel: FleetSentinel } | { type: 'continue' };

/**
 * Legacy sentinel constants — used as fallback when no `validSentinels` are provided.
 */
const LEGACY_SENTINEL_COMPLETE = 'STATUS: COMPLETE';
const LEGACY_SENTINEL_BLOCKED = 'STATUS: BLOCKED';

/**
 * Build a marker-to-sentinel map from the valid sentinels array.
 * e.g. `'STATUS: CHECKLIST_COMPLETE'` → `'CHECKLIST_COMPLETE'`
 */
const buildMarkerMap = (sentinels: FleetSentinel[]): Map<string, FleetSentinel> => {
  const map = new Map<string, FleetSentinel>();
  for (const s of sentinels) {
    map.set(`STATUS: ${s}`, s);
  }
  return map;
};

/**
 * Extract text from a history item's content field.
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
 * Scan history for sentinel values. Column-aware: uses the provided marker map.
 * Falls back to legacy COMPLETE/BLOCKED if no validSentinels provided.
 */
const detectSignal = (
  history: Array<Record<string, unknown>>,
  markerMap: Map<string, FleetSentinel> | null
): DetectedSignal => {
  const lastItems = history.slice(-5).map((item, i) => {
    const idx = history.length - 5 + i;
    const text = extractText(item.content);
    const preview = text ? `"...${text.slice(-100)}"` : 'N/A';
    return `[${idx}] role=${item.role as string | undefined} type=${item.type as string | undefined} text=${preview}`;
  });
  console.log(`[FleetLoop] Last 5 history items:\n${lastItems.join('\n')}`);

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role === 'assistant') {
      const text = extractText(msg.content);
      if (!text) {
        continue;
      }

      // Column-aware detection
      if (markerMap) {
        for (const [marker, sentinel] of markerMap) {
          if (text.includes(marker)) {
            console.log(`[FleetLoop] Found sentinel ${sentinel} in message [${i}]`);
            return { type: 'sentinel', sentinel };
          }
        }
      } else {
        // Legacy fallback
        if (text.includes(LEGACY_SENTINEL_COMPLETE)) {
          console.log(`[FleetLoop] Found legacy COMPLETE sentinel in message [${i}]`);
          return { type: 'sentinel', sentinel: 'CHECKLIST_COMPLETE' };
        }
        if (text.includes(LEGACY_SENTINEL_BLOCKED)) {
          console.log(`[FleetLoop] Found legacy BLOCKED sentinel in message [${i}]`);
          return { type: 'sentinel', sentinel: 'BLOCKED' };
        }
      }
    }
  }
  return { type: 'continue' };
};

// #endregion

// #region Legacy prompt builder (backwards compat)

const LEGACY_SENTINEL_INSTRUCTIONS = `
## CRITICAL: Completion Signals
Your FINAL message MUST end with exactly one of these sentinels on its own line:
- \`STATUS: COMPLETE\` — the task is fully complete, all requirements met, quality checks pass.
- \`STATUS: BLOCKED\` — you are blocked and need human intervention (missing credentials, unclear requirements, external dependency).
If the task is not yet complete and you are not blocked, do NOT output either sentinel — just end your message normally and another iteration will continue your work.
You MUST output a sentinel if the task is complete. Do not forget.`;

const LEGACY_NUDGE_PROMPT = `Continue working on the task. Pick up where you left off and make more progress.
When you are fully done, end your response with \`STATUS: COMPLETE\` on its own line.
If you are blocked and need human intervention, end with \`STATUS: BLOCKED\`.
Do not output a signal if there is still more work to do.`;

const buildLegacyPrompt = (opts: { iteration: number; ticketTitle: string; ticketDescription: string }): string => {
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
${LEGACY_SENTINEL_INSTRUCTIONS}`;
  }

  return `Continue working on the task. This is iteration ${opts.iteration}.
Read progress.txt for context on what's been accomplished so far.
Do not ask questions. Do not narrate. Just proceed with implementation.
${LEGACY_SENTINEL_INSTRUCTIONS}`;
};

// #endregion

// #region Sentinel classification

/** Sentinels that indicate successful column completion. */
const COMPLETING_SENTINELS: ReadonlySet<FleetSentinel> = new Set<FleetSentinel>(['CHECKLIST_COMPLETE', 'NEEDS_REVIEW']);

/** Sentinels that indicate the loop is blocked. */
const BLOCKING_SENTINELS: ReadonlySet<FleetSentinel> = new Set<FleetSentinel>(['BLOCKED', 'TESTS_FAILING', 'REJECTED']);

// #endregion

// #region Types

export type FleetLoopCallbacks = {
  onIterationStart: (iteration: number) => { taskId: FleetTaskId };
  onIterationEnd: (taskId: FleetTaskId, endReason: RunEndReason) => void;
  onSessionStart: (taskId: FleetTaskId, sessionId: string) => void;
  onLoopComplete: (sentinel: FleetSentinel) => void;
  onLoopError: (error: Error) => void;
  onLoopBlocked: (sentinel: FleetSentinel) => void;
  onStatusChange: (status: FleetTicketLoopStatus, iteration: number) => void;
};

export type FleetLoopControllerOpts = {
  wsUrl: string;
  workspaceDir: string;
  maxIterations: number;
  maxNudges?: number;
  startFromIteration?: number;
  callbacks: FleetLoopCallbacks;

  // Column-aware config (Phase 2)
  validSentinels?: FleetSentinel[];
  buildPrompt?: (iteration: number) => string;
  nudgePrompt?: string;

  // Legacy — used when buildPrompt is not provided
  ticketTitle?: string;
  ticketDescription?: string;
};

// #endregion

const BETWEEN_ITERATION_DELAY_MS = 120_000;
const HISTORY_QUERY_TIMEOUT_MS = 5_000;
const MAX_NUDGES_DEFAULT = 3;

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
  private pendingDecision = false;
  private runEndHandled = false;
  private nudgeCount = 0;

  wsUrl: string;
  private workspaceDir: string;
  private callbacks: FleetLoopCallbacks;

  // Column-aware config
  private markerMap: Map<string, FleetSentinel> | null;
  private buildPromptFn: (iteration: number) => string;
  private nudgePromptText: string;

  // Legacy fields for progress.txt
  private ticketTitle: string;

  constructor(opts: FleetLoopControllerOpts) {
    this.wsUrl = opts.wsUrl;
    this.workspaceDir = opts.workspaceDir;
    this.maxIterations = opts.maxIterations;
    this.maxNudges = opts.maxNudges ?? MAX_NUDGES_DEFAULT;
    this.startFromIteration = opts.startFromIteration ?? 1;
    this.callbacks = opts.callbacks;

    // Column-aware sentinel detection
    if (opts.validSentinels && opts.validSentinels.length > 0) {
      this.markerMap = buildMarkerMap(opts.validSentinels);
    } else {
      this.markerMap = null; // legacy fallback
    }

    // Prompt building — prefer injected buildPrompt, fall back to legacy
    if (opts.buildPrompt) {
      this.buildPromptFn = opts.buildPrompt;
    } else {
      const title = opts.ticketTitle ?? '';
      const desc = opts.ticketDescription ?? '';
      this.buildPromptFn = (iteration: number) =>
        buildLegacyPrompt({ iteration, ticketTitle: title, ticketDescription: desc });
    }

    this.nudgePromptText = opts.nudgePrompt ?? LEGACY_NUDGE_PROMPT;
    this.ticketTitle = opts.ticketTitle ?? '';
  }

  start(): void {
    if (this.status !== 'idle') {
      console.log(`[FleetLoop] start() called but status is ${this.status}, ignoring`);
      return;
    }
    this.stopped = false;
    this.iteration = this.startFromIteration;
    console.log(
      `[FleetLoop] Starting loop from iteration ${this.iteration}, max ${this.maxIterations}, wsUrl=${this.wsUrl}`
    );
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
    this.runEndHandled = false;
    this.nudgeCount = 0;
    const { taskId } = this.callbacks.onIterationStart(this.iteration);
    this.currentTaskId = taskId;
    console.log(`[FleetLoop] Iteration ${this.iteration} → taskId=${taskId}`);

    const prompt = this.buildPromptFn(this.iteration);
    this.connectAndSendRun(prompt);
  }

  private sendNudge(): void {
    if (this.stopped || !this.currentSessionId) {
      return;
    }

    this.nudgeCount++;
    console.log(`[FleetLoop] Sending nudge ${this.nudgeCount}/${this.maxNudges} in session ${this.currentSessionId}`);
    this.pendingDecision = false;
    this.runEndHandled = false;

    this.connectAndSendRun(this.nudgePromptText, this.currentSessionId);
  }

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
      const params: Record<string, unknown> = {
        prompt,
        safe_tool_overrides: { safe_tool_patterns: ['.*'] },
      };
      if (sessionId) {
        params.session_id = sessionId;
      }
      console.log(
        `[FleetLoop] WS connected, sending start_run (${sessionId ? `nudge ${this.nudgeCount}` : `iteration ${this.iteration}`})`
      );
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
            this.currentSessionId = result.session_id;
            if (this.currentTaskId) {
              this.callbacks.onSessionStart(this.currentTaskId, result.session_id);
            }
          }
        }

        if (data.id?.startsWith('history-')) {
          console.log(
            `[FleetLoop] Received history response, isArray=${Array.isArray(data.result)}, length=${Array.isArray(data.result) ? data.result.length : 'N/A'}`
          );
          if (Array.isArray(data.result)) {
            this.handleHistoryResponse(data.result as Array<Record<string, unknown>>);
          } else {
            console.log(
              `[FleetLoop] History response not an array, defaulting to continue. data.error=${JSON.stringify(data.error)}`
            );
            this.decideNextStep({ type: 'continue' });
          }
        }


        if (data.method === 'run_end' && data.params) {
          const endReason = data.params.end_reason ?? 'completed';
          console.log(
            `[FleetLoop] run_end received: endReason=${endReason}, iteration=${this.iteration}, nudgeCount=${this.nudgeCount}`
          );
          this.handleRunEnd(endReason);
        }
      } catch {
        // Ignore unparseable messages
      }
    });

    ws.addEventListener('error', (err) => {
      console.log(
        `[FleetLoop] WS error: ${(err as ErrorEvent).message ?? 'unknown'}, settled=${settled}, pendingDecision=${this.pendingDecision}`
      );
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
      console.log(
        `[FleetLoop] WS closed, settled=${settled}, stopped=${this.stopped}, pendingDecision=${this.pendingDecision}`
      );
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
        this.decideNextStep({ type: 'continue' });
      }
    });
  }

  private handleRunEnd(endReason: string): void {
    console.log(
      `[FleetLoop] handleRunEnd: endReason=${endReason}, stopped=${this.stopped}, currentTaskId=${this.currentTaskId}, sessionId=${this.currentSessionId}`
    );
    if (this.stopped || !this.currentTaskId) {
      return;
    }

    if (this.runEndHandled) {
      console.log(`[FleetLoop] Duplicate run_end (endReason=${endReason}), ignoring`);
      return;
    }
    this.runEndHandled = true;

    if (endReason === 'error' || endReason === 'guardrail_violation') {
      // If this was a nudge that errored, don't kill the loop — just move to the next iteration
      if (this.nudgeCount > 0) {
        console.log(
          `[FleetLoop] Nudge ${this.nudgeCount} ended with ${endReason}, treating as non-fatal — moving to next iteration`
        );
        this.endIteration(endReason);
        if (this.iteration >= this.maxIterations) {
          this.setStatus('completed');
          this.callbacks.onLoopComplete('CHECKLIST_COMPLETE');
          return;
        }
        this.iteration++;
        console.log(
          `[FleetLoop] Continuing to iteration ${this.iteration} after ${BETWEEN_ITERATION_DELAY_MS}ms delay`
        );
        this.setStatus('running');
        setTimeout(() => {
          if (!this.stopped) {
            this.startIteration();
          }
        }, BETWEEN_ITERATION_DELAY_MS);
        return;
      }

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

      setTimeout(() => {
        if (this.pendingDecision && !this.stopped) {
          console.log(`[FleetLoop] History query timed out, defaulting to continue`);
          this.decideNextStep({ type: 'continue' });
        }
      }, HISTORY_QUERY_TIMEOUT_MS);
    } else {
      this.decideNextStep({ type: 'continue' });
    }
  }

  private handleHistoryResponse(history: Array<Record<string, unknown>>): void {
    if (this.stopped || !this.pendingDecision) {
      console.log(
        `[FleetLoop] handleHistoryResponse: stopped=${this.stopped}, pendingDecision=${this.pendingDecision}, ignoring`
      );
      return;
    }
    const signal = detectSignal(history, this.markerMap);
    console.log(
      `[FleetLoop] Signal detected from history: ${signal.type === 'sentinel' ? signal.sentinel : 'continue'}`
    );
    this.decideNextStep(signal);
  }

  private decideNextStep(signal: DetectedSignal): void {
    if (!this.pendingDecision) {
      console.log(`[FleetLoop] decideNextStep called but no pendingDecision, ignoring`);
      return;
    }
    this.pendingDecision = false;

    console.log(
      `[FleetLoop] decideNextStep: signal=${signal.type === 'sentinel' ? signal.sentinel : 'continue'}, iteration=${this.iteration}/${this.maxIterations}, nudges=${this.nudgeCount}/${this.maxNudges}`
    );

    if (signal.type === 'sentinel') {
      const { sentinel } = signal;

      if (COMPLETING_SENTINELS.has(sentinel)) {
        this.endIteration(sentinel);
        console.log(`[FleetLoop] Task signaled ${sentinel} (completing), finishing loop`);
        this.setStatus('completed');
        this.callbacks.onLoopComplete(sentinel);
        return;
      }

      if (BLOCKING_SENTINELS.has(sentinel)) {
        this.endIteration(sentinel);
        console.log(`[FleetLoop] Task signaled ${sentinel} (blocking), stopping loop`);
        this.setStatus('stopped');
        this.callbacks.onLoopBlocked(sentinel);
        return;
      }
    }

    // signal.type === 'continue' — no sentinel found
    // Wait before nudging so the human has time to interject (e.g. the agent asked them to do something)
    if (this.nudgeCount < this.maxNudges) {
      console.log(
        `[FleetLoop] No sentinel found, will nudge (${this.nudgeCount + 1}/${this.maxNudges}) after ${BETWEEN_ITERATION_DELAY_MS}ms delay`
      );
      setTimeout(() => {
        if (!this.stopped) {
          this.sendNudge();
        }
      }, BETWEEN_ITERATION_DELAY_MS);
      return;
    }

    console.log(`[FleetLoop] No sentinel after ${this.maxNudges} nudges, moving to next iteration`);
    this.endIteration('continue');

    if (this.iteration >= this.maxIterations) {
      console.log(`[FleetLoop] Max iterations reached (${this.maxIterations}), finishing loop`);
      this.setStatus('completed');
      this.callbacks.onLoopComplete('CHECKLIST_COMPLETE');
      return;
    }

    this.iteration++;
    console.log(`[FleetLoop] Continuing to iteration ${this.iteration} after ${BETWEEN_ITERATION_DELAY_MS}ms delay`);
    this.setStatus('running');
    setTimeout(() => {
      if (!this.stopped) {
        this.startIteration();
      }
    }, BETWEEN_ITERATION_DELAY_MS);
  }

  private endIteration(signal: FleetSentinel | 'continue'): void {
    if (this.currentTaskId) {
      const duration = Math.round((Date.now() - this.iterationStartTime) / 1000);
      console.log(
        `[FleetLoop] Ending iteration ${this.iteration}, taskId=${this.currentTaskId}, duration=${duration}s, signal=${signal}, nudges=${this.nudgeCount}`
      );
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
