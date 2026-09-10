import { createActor } from 'xstate';

import { uuidv4 } from '@/lib/uuid';
import {
  normalizeSubagentSnapshot,
  publishBashJobs,
  publishSubagentEvent,
  publishSubagentsSnapshot,
} from '@/renderer/omniagents-ui/activity-store';
import { prepareConversation } from '@/renderer/omniagents-ui/prepare-conversation';
import { adaptCanonicalConversationItems } from '@/renderer/omniagents-ui/rpc/canonical-chat-history';
import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';
import { ClientRequestNotPendingError } from '@/renderer/omniagents-ui/rpc/client-response-error';
import {
  findSlashCommand,
  normalizeSlashCommand,
  parseSlashArgs,
  parseSlashLine,
  type SlashCommand,
  unknownCommandMessage,
  slashResultMessage,
} from '@/renderer/omniagents-ui/rpc/slash';
import { ConnectionClosedError, RpcTimeoutError } from '@/shared/lifecycle';
import { type ChatSessionEvent, chatSessionMachine } from '@/shared/machines/chat-session.machine';
import { createMachineLogger } from '@/shared/machines/machine-logger';
import type { ExecutionTarget, RunOverrides } from '@/shared/types';

import { encodeMessage } from './encode-message';
import { SessionPanelStore } from './session-panels';
import { wireSessionTranscript } from './session-transcript';

/** How long a lost-reply receipt lookup waits for the socket to come back. */
const RECEIPT_LOOKUP_TIMEOUT_MS = 15_000;

type Listener = (payload: any) => void;
export type SessionToolHandler = (
  tool: string,
  args: Record<string, unknown>
) => Promise<{
  ok: boolean;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}>;
export type SendOptions = {
  inputId?: string;
  executionTarget?: ExecutionTarget;
  variables?: Record<string, unknown>;
  overrides?: RunOverrides;
  workspaceSupported?: boolean;
};

/** Durable in-memory owner for exactly one session on exactly one connection.
 * No selected-session ref, React setters, or navigation callbacks belong here. */
export class ConversationSession {
  readonly actor = createActor(chatSessionMachine, { inspect: createMachineLogger('chatSession') }).start();
  readonly panels = new SessionPanelStore();
  disposed = false;
  private reconnectRevision = 0;
  private stops = new Map<string, Promise<void>>();
  private listeners = new Map<string, Set<Listener>>();
  private transcript: ReturnType<typeof wireSessionTranscript>;
  private loading?: Promise<string>;
  private registered = false;
  private workersRevision = 0;
  private submission: Promise<unknown> = Promise.resolve();
  private pendingSubmissions = 0;
  private toolHandler?: SessionToolHandler;
  private acknowledged = new Set<string>();
  private clientResults = new Map<string, Promise<Awaited<ReturnType<SessionToolHandler>>>>();
  private clientDeliveries = new Map<string, Promise<void>>();
  private intents = new Set<string>();
  private panelTarget?: ExecutionTarget;
  private panelWorkspaceSupported = false;
  private panelsInitialized = false;
  private snapshotEvents: Array<{ method: string; payload: any }> | undefined;
  private snapshotCursor?: { stream: string; seq: number };

  constructor(
    readonly id: string,
    readonly client: RPCClient
  ) {
    this.actor.send({ type: 'SELECT_SESSION', id });
    this.transcript = wireSessionTranscript(this, client);
  }

  on = (method: string, listener: Listener) => {
    let handlers = this.listeners.get(method);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(method, handlers);
    }
    handlers.add(listener);
    return () => {
      handlers.delete(listener);
    };
  };

  dispatch(method: string, payload: any) {
    if (this.disposed || (payload?.session_id ?? payload?.thread_id) !== this.id) {
      return;
    }
    if (this.snapshotEvents) {
      this.snapshotEvents.push({ method, payload });
      return;
    }
    if (this.snapshotCursor && typeof payload?.seq === 'number' && this.snapshotCursor.stream === payload.stream_id) {
      if (payload.seq <= this.snapshotCursor.seq) {
        return;
      }
      this.snapshotCursor.seq = payload.seq;
    }
    if (method === 'queue_changed') {
      this.panels.set('queuedMessages', Array.isArray(payload?.items) ? payload.items : []);
    }
    if (method === 'run_started') {
      this.panels.set('recap', null);
    }
    if (method === 'client_request_resolved' && this.panels.state.get().escalation?.request_id === payload.request_id) {
      this.panels.set('escalation', null);
    }
    if (method === 'client_request') {
      this.handleClientRequest(payload);
    }
    for (const handler of this.listeners.get(method) ?? []) {
      handler(payload);
    }
  }

  claimIntent(key: string) {
    if (this.intents.has(key)) {
      return false;
    }
    this.intents.add(key);
    return true;
  }
  receive = (event: ChatSessionEvent) => {
    if (!this.disposed) {
      this.actor.send(event);
    }
  };

  /** A host installs session capabilities; view unmount is not revocation. */
  setToolHandler(handler: SessionToolHandler) {
    if (!this.disposed) {
      this.toolHandler = handler;
    }
  }

  private deliverClientResult(requestId: string) {
    if (this.disposed || this.acknowledged.has(requestId) || this.clientDeliveries.has(requestId)) {
      return;
    }
    const result = this.clientResults.get(requestId);
    if (!result) {
      return;
    }
    const delivery = result
      .then(async (response) => {
        if (this.disposed) {
          return;
        }
        await this.client.clientResponse(requestId, response.ok, response.result, response.error);
        this.acknowledged.add(requestId);
        this.clientResults.delete(requestId);
      })
      .catch((error) => {
        if (error instanceof ClientRequestNotPendingError) {
          // The server definitively retired this request. Release cached
          // output, but remember the ID so a replay cannot execute it again.
          this.acknowledged.add(requestId);
          this.clientResults.delete(requestId);
        }
        // Transport failure is not tool failure. Retain the actual result for
        // pending-request replay, without executing the tool again.
      })
      .finally(() => this.clientDeliveries.delete(requestId));
    this.clientDeliveries.set(requestId, delivery);
  }

  private handleClientRequest(p: any) {
    const fn = String(p?.function ?? '');
    const requestId = typeof p?.request_id === 'string' ? p.request_id : '';
    if (requestId && this.acknowledged.has(requestId)) {
      return;
    }
    if (requestId && this.clientResults.has(requestId)) {
      this.deliverClientResult(requestId);
      return;
    }
    const args = p?.args ?? {};
    const ack = () => {
      if (!requestId) {
        return;
      }
      this.clientResults.set(requestId, Promise.resolve({ ok: true, result: { ack: true } }));
      this.deliverClientResult(requestId);
    };
    switch (fn) {
      case 'ui.set_status':
        this.receive({
          type: 'SET_STATUS',
          text: typeof args.text === 'string' ? args.text : undefined,
          showSpinner: typeof args.show_spinner === 'boolean' ? args.show_spinner : true,
          session_id: this.id,
        });
        break;
      case 'ui.set_session_state':
        // Session state can change in another window or via a server command.
        // Route through the same field revisions as local mutations so stale
        // catalog reads cannot overwrite these authoritative notifications.
        if (typeof args.model === 'string' || args.model === null) {
          this.panels.set('activeModel', args.model);
        }
        if (typeof args.reasoning_effort === 'string' || args.reasoning_effort === null) {
          this.panels.set('reasoningEffort', args.reasoning_effort);
        }
        if (args.approvals_reviewer === 'user' || args.approvals_reviewer === 'auto') {
          this.panels.set('approvalsReviewer', args.approvals_reviewer);
        }
        if (args.workflow_reviewer === 'off' || args.workflow_reviewer === 'guardian') {
          this.panels.set('workflowReviewer', args.workflow_reviewer);
        }
        break;
      case 'ui.add_artifact':
        this.receive({
          type: 'ADD_ARTIFACT',
          title: String(args.title ?? ''),
          content: String(args.content ?? ''),
          mode: args.mode ?? 'markdown',
          artifact_id: args.artifact_id,
          session_id: this.id,
        });
        break;
      case 'ui.bash_jobs.update':
        if (Array.isArray(args.snapshot)) {
          this.panels.set('liveBashJobs', args.snapshot);
          publishBashJobs(this.id, args.snapshot);
        }
        break;
      case 'ui.workers.update':
      case 'ui.subagents.update':
        this.workersRevision++;
        if (Array.isArray(args.snapshot)) {
          publishSubagentsSnapshot(this.id, normalizeSubagentSnapshot(args.snapshot));
        }
        break;
      case 'ui.subagent.event':
        if (args.kind === 'agent_tool' && args.subagent_id) {
          publishSubagentEvent(this.id, args.subagent_id, String(args.method ?? ''), args.params ?? {});
        }
        break;
      case 'notify':
        if (typeof args.message === 'string') {
          this.panels.set('notifications', (previous) => [
            ...previous,
            { id: requestId || uuidv4(), message: args.message, timestamp: Date.now() },
          ]);
        }
        break;
      case 'ui.recap':
        if (typeof args.text === 'string') {
          this.panels.set('recap', { text: args.text, timestamp: Date.now() });
        }
        break;
      case 'ui.goal.update':
        this.panels.set('goalSnapshot', args.snapshot ?? null);
        break;
      case 'ui.wakeup.update':
        this.panels.set('wakeupSnapshot', args.snapshot ?? null);
        break;
      case 'ui.loop.update':
        this.panels.set('loopTasks', Array.isArray(args.snapshot) ? args.snapshot : []);
        break;
      case 'escalate':
        if (requestId) {
          this.panels.set('escalation', {
            request_id: requestId,
            message: String(args.message ?? ''),
            session_id: this.id,
            run_id: p.run_id,
          });
        }
        return; // Blocking: only an explicit user reply resolves it.
      case 'tool.call': {
        if (!requestId) {
          return;
        }
        const handler = this.toolHandler;
        this.clientResults.set(
          requestId,
          Promise.resolve().then(async () => {
            try {
              return handler
                ? await handler(String(args.tool ?? ''), args.arguments ?? {})
                : { ok: false, error: { message: 'No client tool handler registered for this session' } };
            } catch (error) {
              return { ok: false, error: { message: String(error) } };
            }
          })
        );
        this.deliverClientResult(requestId);
        return;
      }
      default:
        return;
    }
    ack();
  }

  /** Coalesced hydration. Ready is published only after the atomic snapshot
   * (history, queue, pending requests, active-run status) and draft settings
   * have all been reconciled. */
  load(options: { force?: boolean } = {}): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new Error('Conversation connection was closed'));
    }
    if (this.loading) {
      return this.loading;
    }
    if (!options.force && this.actor.getSnapshot().matches('ready')) {
      return Promise.resolve(this.id);
    }
    this.actor.send({ type: 'HYDRATE' });
    this.loading = (async () => {
      try {
        this.registered = true;
        await this.client.registerSession(this.id);
        await this.transcript.recover();
        if (typeof this.client.getSessionSnapshot !== 'function') {
          throw new Error('Internal error: this connection cannot read conversation snapshots.');
        }
        await prepareConversation(this.client, this.id);
        this.snapshotEvents = [];
        const result = await this.client.getSessionSnapshot(this.id);
        if (this.disposed) {
          throw new Error('Conversation connection was closed');
        }
        const snapshot = result.snapshot;
        const items = adaptCanonicalConversationItems(snapshot.items);
        this.panels.set('queuedMessages', snapshot.queue);
        this.panels.set('escalation', null);
        if (items.length || result.run_active || snapshot.queue.length) {
          this.panels.set('workspaceLocked', true);
        }
        this.snapshotCursor = { stream: snapshot.stream_id, seq: snapshot.last_seq };
        this.actor.send({
          type: 'HISTORY_LOADED',
          items,
          active_run_id: result.run_active ? result.active_run_id : undefined,
        });
        const buffered = this.snapshotEvents;
        this.snapshotEvents = undefined;
        for (const event of snapshot.state_events ?? []) {
          if (event.method === 'run_status') {
            this.receive({
              type: 'RUN_STATUS',
              text: [event.params.status, event.params.message].filter(Boolean).join(': '),
              session_id: this.id,
            });
          } else if (event.method === 'client_request') {
            // These are display snapshots, not live waiters. Apply even if
            // the original request was acknowledged, without answering again.
            this.handleClientRequest({ ...event.params, request_id: undefined });
          }
        }
        // Pending requests are part of the snapshot even when their event
        // predates its watermark. They must not wait for a future replay.
        for (const payload of snapshot.pending_requests) {
          this.handleClientRequest(payload);
        }
        for (const event of buffered) {
          if (typeof event.payload?.seq === 'number') {
            this.dispatch(event.method, event.payload);
          }
        }
        await this.client.completeSessionResync(this.id, snapshot.stream_id, snapshot.last_seq);
        return this.id;
      } catch (error) {
        this.receive({ type: 'HISTORY_ERROR', error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        this.snapshotEvents = undefined;
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  reconnected() {
    if (!this.registered || this.disposed) {
      return;
    }
    const revision = ++this.reconnectRevision;
    const pendingLoad = this.loading;
    void (async () => {
      // A reconnect must not merely join hydration from the dead connection.
      // Let it retire, then read from the current connection exactly once.
      await pendingLoad?.catch(() => {});
      if (this.disposed || !this.client.isConnected || revision !== this.reconnectRevision) {
        return;
      }
      await this.load({ force: true });
      if (this.panelsInitialized && !this.disposed && revision === this.reconnectRevision) {
        await this.refreshPanels(this.panelTarget, this.panelWorkspaceSupported);
      }
    })().catch(() => {});
  }

  async refreshPanels(target?: ExecutionTarget, workspaceSupported = false) {
    this.panelTarget = target;
    this.panelWorkspaceSupported = workspaceSupported;
    this.panelsInitialized = true;
    const read = async (name: string) => (await this.client.serverCall(name, {}, this.id, target)) as any;
    const workersRevision = this.workersRevision;
    await Promise.allSettled([
      this.panels.refresh('queuedMessages', async () => (await this.client.listQueue(this.id)).items),
      this.panels.refresh('goalSnapshot', async () => (await read('goal.status'))?.snapshot ?? null),
      this.panels.refresh('wakeupSnapshot', async () => (await read('wakeup.status'))?.snapshot ?? null),
      this.panels.refresh('loopTasks', async () => (await read('loop.status'))?.snapshot ?? []),
      workspaceSupported
        ? this.panels.refresh(
            'workspacePath',
            async () => (await read('fs_get_workspace_root'))?.path ?? this.panels.state.get().workspacePath
          )
        : Promise.resolve(),
      read('workers.list').then((result) => {
        if (!this.disposed && workersRevision === this.workersRevision && Array.isArray(result?.snapshot)) {
          publishSubagentsSnapshot(this.id, normalizeSubagentSnapshot(result.snapshot));
        }
      }),
    ]);
  }

  /** Submission is serialized per session, not per composer. Two views of A
   * cannot both decide A is idle and start competing runs. */
  send(text: string, files?: File[], options: SendOptions = {}): Promise<{ runId: string } | undefined> {
    this.pendingSubmissions++;
    const task = this.submission
      .then(() => this.sendNow(text, files, options))
      .finally(() => this.pendingSubmissions--);
    this.submission = task.catch(() => {});
    return task;
  }

  /** Idle cache eviction must never abort local work or a pending interaction. */
  get canEvict(): boolean {
    const snapshot = this.actor.getSnapshot();
    const panels = this.panels.state.get();
    return (
      !this.loading &&
      !this.pendingSubmissions &&
      !this.stops.size &&
      !this.clientResults.size &&
      !this.clientDeliveries.size &&
      (snapshot.matches({ ready: 'idle' }) ||
        snapshot.matches('initError') ||
        (!this.registered && snapshot.matches('initializing'))) &&
      !snapshot.context.pendingApprovals.size &&
      !panels.escalation &&
      !panels.queuedMessages.length &&
      !panels.modelMutating &&
      !panels.networkMutating &&
      !panels.goalSnapshot &&
      !panels.wakeupSnapshot &&
      !panels.loopTasks.length
    );
  }

  private assertReady() {
    if (this.panels.state.get().modelMutating) {
      throw new Error('Model settings are still updating. Your message has been kept; please retry.');
    }
    if (this.disposed || !this.client.isConnected || this.loading || !this.actor.getSnapshot().matches('ready')) {
      throw new Error('Conversation is still connecting. Your message has been kept; please retry.');
    }
  }

  private async sendNow(text: string, files: File[] | undefined, options: SendOptions) {
    this.assertReady();
    const escalation = this.panels.state.get().escalation;
    if (escalation && !text.startsWith('/')) {
      const { content } = await encodeMessage(text, files);
      this.assertReady();
      const requestId = escalation.request_id;
      // The question id is the answer's identity: the server keeps a receipt
      // per request, so an exact resend of the same answer is acknowledged
      // without being consumed twice. A transport failure is reported as is;
      // the composer keeps the text and the user decides whether to resend.
      try {
        await this.client.clientResponse(requestId, true, {
          reply: text,
          ...(content ? { input_content: content } : {}),
        });
      } catch (error) {
        if (
          error instanceof ClientRequestNotPendingError &&
          this.panels.state.get().escalation?.request_id === requestId
        ) {
          this.panels.set('escalation', null);
        }
        throw error;
      }
      if (this.panels.state.get().escalation?.request_id === requestId) {
        this.panels.set('escalation', null);
      }
      return undefined;
    }
    const slash = files?.length ? null : parseSlashLine(text);
    if (slash) {
      // The catalog is the server's typeable subset; an unknown name is
      // refused here (the composer keeps the text), never sent to the model.
      const rows = (await this.client.listSlashCommands())
        .map(normalizeSlashCommand)
        .filter((row): row is SlashCommand => row !== null);
      const command = findSlashCommand(rows, slash.name);
      if (!command) {
        throw new Error(unknownCommandMessage(slash.name));
      }
      const parsedArgs = parseSlashArgs(command.args, slash.rest);
      if (parsedArgs.ok === false) {
        throw new Error(
          `/${command.name}: ${parsedArgs.error}${command.usage ? ` Usage: /${command.name} ${command.usage}` : ''}`
        );
      }
      if (!command.during_run && !this.actor.getSnapshot().matches({ ready: 'idle' })) {
        throw new Error(`/${command.name} can't run while a response is in progress. Stop it first.`);
      }
      const functionName = command.function ?? command.name;
      this.assertReady();
      const apply = async () => {
        const result = await this.client.serverCall(functionName, parsedArgs.args, this.id, options.executionTarget);
        if (command.name === 'recap') {
          const recap = (result as { text?: unknown })?.text;
          return typeof recap === 'string' ? { text: recap, timestamp: Date.now() } : this.panels.state.get().recap;
        }
        this.receive({ type: 'APPEND_RESPONSE', content: slashResultMessage(result) });
        return null;
      };
      if (command.name === 'recap') {
        await this.panels.refresh('recap', apply);
      } else {
        await apply();
      }
      return undefined;
    }
    const { content: encodedContent, attachments } = await encodeMessage(text, files);
    this.assertReady();
    const staged = this.actor.getSnapshot().context.stagedContext.slice();
    const prompt = text || (files?.length ? `Attached files: ${files.map((file) => file.name).join(', ')}` : '');
    const agentPrompt = staged.length ? `${staged.map((entry) => entry.text).join('\n\n')}\n\n${prompt}` : prompt;
    // Structured content replaces prompt at the model boundary. Include the
    // same staged context there, for both direct and queued submissions.
    const content =
      encodedContent && staged.length
        ? [{ type: 'input_text', text: staged.map((entry) => entry.text).join('\n\n') }, ...encodedContent]
        : encodedContent;
    const base = options.variables;
    const overrides = options.overrides;
    const variables = overrides
      ? {
          ...base,
          ...(overrides.additionalInstructions
            ? {
                additional_instructions: [overrides.additionalInstructions, base?.additional_instructions]
                  .filter(Boolean)
                  .join('\n\n'),
              }
            : {}),
          ...(overrides.safeToolOverrides ? { safe_tool_overrides: overrides.safeToolOverrides } : {}),
          ...(overrides.approvalsReviewer ? { approvals_reviewer: overrides.approvalsReviewer } : {}),
        }
      : base;
    const queued =
      !this.actor.getSnapshot().matches({ ready: 'idle' }) || this.panels.state.get().queuedMessages.length > 0;
    const submissionId = options.inputId ?? uuidv4();
    if (queued) {
      const result = await this.submitOnce(submissionId, () =>
        this.client.enqueueMessage(this.id, agentPrompt, {
          triggerRun: true,
          role: 'user',
          variables,
          source: 'ui',
          inputContent: content,
          submissionId,
        })
      );
      if (!result.ok) {
        throw new Error(result.reason ?? 'Message was not queued. Please retry.');
      }
      this.clearSentContext(staged);
      if (options.workspaceSupported) {
        this.panels.set('workspaceLocked', true);
      }
      return { runId: '' };
    }
    this.receive({ type: 'SUBMIT', text, attachments, stagedContext: staged });
    try {
      const target = options.executionTarget;
      const result = await this.submitOnce(submissionId, () =>
        this.client.startRun(
          agentPrompt,
          target
            ? {
                mode: 'explicit',
                environment_id: target.environmentId,
                environment_generation: target.environmentGeneration,
              }
            : { mode: 'none' },
          this.id,
          variables,
          content,
          submissionId
        )
      );
      this.clearSentContext(staged);
      if (options.workspaceSupported) {
        this.panels.set('workspaceLocked', true);
      }
      return { runId: String(result?.run_id ?? '') };
    } catch (error) {
      this.receive({ type: 'SUBMIT_ERROR', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * At-most-once delivery. One attempt is made. If the transport fails before
   * a reply arrives, the server is asked once for the receipt of that
   * submission id: a completed receipt means the message landed, so its result
   * is adopted and the transcript reloaded. Anything else is reported as the
   * original failure and the composer puts the text back; a resend is a new
   * submission, while the server's receipt still dedupes a retry of this id.
   */
  private async submitOnce<T>(submissionId: string, attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ConnectionClosedError || error instanceof RpcTimeoutError)) {
        throw error;
      }
      let receipt: { status?: string; result?: unknown } | undefined;
      try {
        if (!this.client.isConnected) {
          await this.client.connectAndWait(RECEIPT_LOOKUP_TIMEOUT_MS);
        }
        const status: any = await this.client.request('queue_status', {
          session_id: this.id,
          submission_id: submissionId,
        });
        receipt = status?.submission;
      } catch {
        throw error;
      }
      if (this.disposed || receipt?.status !== 'completed') {
        throw error;
      }
      // The message is in the transcript now. A failed reload is a hydration
      // problem with its own retry, not a failed send.
      await this.load({ force: true }).catch(() => {});
      return receipt.result as T;
    }
  }

  private clearSentContext(sent: ReadonlyArray<{ source: string; text: string }>) {
    for (const entry of sent) {
      if (
        this.actor
          .getSnapshot()
          .context.stagedContext.some((current) => current.source === entry.source && current.text === entry.text)
      ) {
        this.receive({ type: 'STAGE_CONTEXT', source: entry.source, text: '' });
      }
    }
  }

  /** Cancellation belongs to this session, never the currently focused view. */
  stopRun(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('Conversation connection was closed'));
    }
    const runId = this.actor.getSnapshot().context.runId;
    if (!runId) {
      return Promise.resolve();
    }
    const pending = this.stops.get(runId);
    if (pending) {
      return pending;
    }
    this.receive({ type: 'STOP' });
    const operation = Promise.resolve()
      .then(() => this.client.stopRun(runId))
      .then(() => undefined)
      .catch((error: unknown) => {
        // A late failure must not roll back a newer run or a completed stop.
        const snapshot = this.actor.getSnapshot();
        if (!this.disposed && snapshot.context.runId === runId && snapshot.matches({ ready: 'stopping' })) {
          const message = error instanceof Error ? error.message : String(error);
          this.receive({ type: 'STOP_FAILED', run_id: runId });
          this.receive({ type: 'APPEND_RESPONSE', content: `Could not stop the run: ${message}. Please retry.` });
        }
        throw error;
      })
      .finally(() => this.stops.delete(runId));
    this.stops.set(runId, operation);
    return operation;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.panels.dispose();
    this.transcript.dispose();
    this.listeners.clear();
    this.toolHandler = undefined;
    this.clientResults.clear();
    this.clientDeliveries.clear();
    if (this.registered) {
      this.client.unregisterSession(this.id);
    }
    this.actor.stop();
  }
}
