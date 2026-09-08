import { createActor } from 'xstate';

import { uuidv4 } from '@/lib/uuid';
import {
  normalizeSubagentSnapshot,
  publishBashJobs,
  publishSubagentEvent,
  publishSubagentsSnapshot,
} from '@/renderer/omniagents-ui/activity-store';
import {
  draftsReady,
  flushConversationDrafts,
  getConversationDraft,
  updateConversationDraft,
} from '@/renderer/omniagents-ui/conversation-drafts';
import { prepareConversation } from '@/renderer/omniagents-ui/prepare-conversation';
import {
  adaptCanonicalConversationItems,
  loadSessionTranscript,
} from '@/renderer/omniagents-ui/rpc/canonical-chat-history';
import type { RPCClient } from '@/renderer/omniagents-ui/rpc/client';
import { ClientRequestNotPendingError } from '@/renderer/omniagents-ui/rpc/client-response-error';
import { type ChatSessionEvent, chatSessionMachine } from '@/shared/machines/chat-session.machine';
import { createMachineLogger } from '@/shared/machines/machine-logger';
import type { ExecutionTarget, RunOverrides } from '@/shared/types';

import { encodeMessage } from './encode-message';
import { SessionPanelStore } from './session-panels';
import { wireSessionTranscript } from './session-transcript';

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
  private environmentRevision = 0;
  private reconnectRevision = 0;
  private stops = new Map<string, Promise<void>>();
  private listeners = new Map<string, Set<Listener>>();
  private transcript: ReturnType<typeof wireSessionTranscript>;
  private loading?: Promise<string>;
  private registered = false;
  private runRevision = 0;
  private transcriptRevision = 0;
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
    if (
      [
        'message_output',
        'tool_called',
        'tool_result',
        'item_updated',
        'tool_approval_requested',
        'tool_approval_resolved',
        'mcp_approval_requested',
        'mcp_approval_resolved',
      ].includes(method)
    ) {
      this.transcriptRevision++;
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

  noteRunEvent() {
    this.runRevision++;
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

  /** Coalesced hydration. Ready is published only after history, active-run
   * status and draft settings have all been reconciled. */
  load(options: { force?: boolean; authoritativeResync?: boolean } = {}): Promise<string> {
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
        if (typeof this.client.getSessionSnapshot === 'function') {
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
        }
        // The transcript protocol has no atomic history/event watermark.
        // Re-read if transcript events raced the snapshot instead of erasing
        // them with an older history response. Never declare uncertain state ready.
        for (let attempt = 0; ; attempt++) {
          const revision = this.transcriptRevision;
          const runRevision = this.runRevision;
          const queueFresh = this.panels.guardRead(['queuedMessages']);
          const [history, queue, queued] = await Promise.all([
            loadSessionTranscript(this.client, this.id),
            this.client.request('queue_status', { session_id: this.id }),
            this.client.listQueue(this.id),
          ]);
          if (this.disposed) {
            throw new Error('Conversation connection was closed');
          }
          if (revision !== this.transcriptRevision || runRevision !== this.runRevision) {
            if (attempt >= 4) {
              throw new Error('Conversation is changing while loading. Please retry synchronization.');
            }
            continue;
          }
          await prepareConversation(this.client, this.id);
          if (revision !== this.transcriptRevision || runRevision !== this.runRevision) {
            if (attempt >= 4) {
              throw new Error('Conversation is changing while loading. Please retry synchronization.');
            }
            continue;
          }
          if (this.disposed) {
            throw new Error('Conversation connection was closed');
          }
          if (queueFresh()) {
            this.panels.set('queuedMessages', queued.items);
          }
          if (history.items.length || queue.run_active || queued.items.length) {
            this.panels.set('workspaceLocked', true);
          }
          this.loading = undefined;
          this.actor.send({
            type: 'HISTORY_LOADED',
            items: history.items,
            active_run_id:
              queue.run_active && typeof queue.active_run_id === 'string' ? queue.active_run_id : undefined,
          });
          break;
        }
        if (options.authoritativeResync) {
          await this.client.completeSessionResync(this.id);
        }
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
    if (
      this.panelTarget?.environmentId !== target?.environmentId ||
      this.panelTarget?.environmentGeneration !== target?.environmentGeneration ||
      this.panelTarget?.workspaceId !== target?.workspaceId
    ) {
      this.environmentRevision++;
    }
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
    const environmentRevision = this.environmentRevision;
    // The composer persists this identity before encoding. Another window may
    // finish a retry while our encoding is still pending, clearing shared state.
    // Keep the admitted identity through that await instead of minting a new one.
    const inputId = options.inputId;
    const task = this.submission
      .then(() => this.sendNow(text, files, options, environmentRevision, inputId))
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

  private assertReady(environmentRevision: number, inputId?: string) {
    const pendingInput = getConversationDraft(this.id).pendingInput;
    if (pendingInput?.id && pendingInput.id !== inputId) {
      throw new Error('Another message is pending in this conversation. Review it before sending a different message.');
    }
    if (environmentRevision !== this.environmentRevision) {
      throw new Error('The execution environment changed. Your message has been kept; review it before retrying.');
    }
    if (this.panels.state.get().modelMutating) {
      throw new Error('Model settings are still updating. Your message has been kept; please retry.');
    }
    if (this.disposed || !this.client.isConnected || this.loading || !this.actor.getSnapshot().matches('ready')) {
      throw new Error('Conversation is still connecting. Your message has been kept; please retry.');
    }
  }

  private async sendNow(
    text: string,
    files: File[] | undefined,
    options: SendOptions,
    environmentRevision: number,
    inputId?: string
  ) {
    this.assertReady(environmentRevision, inputId);
    await draftsReady;
    this.assertReady(environmentRevision, inputId);
    const pendingResponse = getConversationDraft(this.id).pendingSubmission;
    const escalation = this.panels.state.get().escalation;
    if ((pendingResponse?.responseId || (escalation && !pendingResponse)) && !text.startsWith('/')) {
      const { content } = await encodeMessage(text, files);
      this.assertReady(environmentRevision, inputId);
      const signature = JSON.stringify([text, content]);
      if (pendingResponse?.responseId && pendingResponse.signature !== signature) {
        throw new Error(
          'Retry the original answer first to confirm its outcome. It will not be sent as a new message.'
        );
      }
      const responseId = pendingResponse?.responseId ?? escalation!.request_id;
      // Retry the original identity even if it disappeared from the pending
      // snapshot: only its receipt can distinguish acceptance from cancellation.
      updateConversationDraft(this.id, { pendingSubmission: { id: responseId, responseId, signature, queued: false } });
      await flushConversationDrafts(this.id);
      this.assertReady(environmentRevision, inputId);
      try {
        await this.client.clientResponse(responseId, true, {
          reply: text,
          ...(content ? { input_content: content } : {}),
        });
      } catch (error) {
        if (error instanceof ClientRequestNotPendingError) {
          updateConversationDraft(this.id, { pendingSubmission: undefined }, { submissionId: responseId });
          if (this.panels.state.get().escalation?.request_id === responseId) {
            this.panels.set('escalation', null);
          }
        }
        throw error;
      }
      updateConversationDraft(
        this.id,
        { pendingSubmission: undefined, pendingInput: undefined, error: undefined },
        { submissionId: responseId }
      );
      if (this.panels.state.get().escalation?.request_id === responseId) {
        this.panels.set('escalation', null);
      }
      return undefined;
    }
    if (text.startsWith('/') && !files?.length) {
      const command = text.trim().split(/\s+/)[0]!.slice(1);
      const functions = await this.client.listServerFunctions();
      const found = functions.find((fn) => fn.name.toLowerCase() === command.toLowerCase());
      if (found) {
        const raw = text.slice(command.length + 1).trim();
        let args: Record<string, unknown> = {};
        if (raw) {
          try {
            const parsed: unknown = JSON.parse(raw);
            args = Array.isArray(parsed)
              ? { args: parsed }
              : parsed && typeof parsed === 'object'
                ? (parsed as Record<string, unknown>)
                : typeof parsed === 'string'
                  ? { text: parsed }
                  : { value: parsed };
          } catch {
            args = { text: raw };
          }
        }
        this.assertReady(environmentRevision, inputId);
        const apply = async () => {
          const result = await this.client.serverCall(found.name, args, this.id, options.executionTarget);
          if (command.toLowerCase() === 'recap') {
            const recap = (result as { text?: unknown })?.text;
            return typeof recap === 'string' ? { text: recap, timestamp: Date.now() } : this.panels.state.get().recap;
          }
          const formatted = JSON.stringify(result, null, 2);
          this.receive({
            type: 'APPEND_RESPONSE',
            content: formatted == null || formatted === 'null' ? 'Done.' : formatted,
          });
          return null;
        };
        if (command.toLowerCase() === 'recap') {
          await this.panels.refresh('recap', apply);
        } else {
          await apply();
        }
        return undefined;
      }
    }
    const { content: encodedContent, attachments } = await encodeMessage(text, files);
    this.assertReady(environmentRevision, inputId);
    const staged =
      getConversationDraft(this.id).pendingSubmission?.stagedContext ??
      this.actor.getSnapshot().context.stagedContext.slice();
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
    await draftsReady;
    let pending = getConversationDraft(this.id).pendingSubmission;
    const signature = JSON.stringify([agentPrompt, content]);
    let submissionVariables = variables;
    let submissionTarget = options.executionTarget;
    let recovered: any;
    let retryFailedSubmission = false;
    if (!pending && inputId) {
      // Another window may have completed and cleared the durable checkpoint
      // while this attempt was encoding. Do not append optimistic UI for an
      // already accepted run: its cached reply produces no new run events.
      const status: any = await this.client.request('queue_status', { session_id: this.id, submission_id: inputId });
      if (status.submission?.status === 'completed') {
        recovered = status.submission.result;
      }
      retryFailedSubmission = status.submission?.status === 'failed';
    }
    if (pending) {
      const status: any = await this.client.request('queue_status', { session_id: this.id, submission_id: pending.id });
      const receipt = status.submission;
      if (receipt?.status === 'failed') {
        retryFailedSubmission = true;
        updateConversationDraft(this.id, { pendingSubmission: undefined }, { submissionId: pending.id });
        pending = undefined;
      } else if (pending.signature !== signature) {
        if (receipt?.status === 'completed') {
          updateConversationDraft(this.id, { pendingSubmission: undefined }, { submissionId: pending.id });
          throw new Error(
            'The previous message was accepted. Review your edited draft before sending it as a new message.'
          );
        } else {
          throw new Error(
            'The previous send is still unresolved. Retry its original text and attachments before sending a different message.'
          );
        }
      } else if (receipt?.status === 'completed') {
        recovered = receipt.result;
      } else if (receipt) {
        submissionVariables = pending.variables;
        submissionTarget = pending.executionTarget;
      }
    }
    const queued =
      pending?.queued ??
      (!this.actor.getSnapshot().matches({ ready: 'idle' }) || this.panels.state.get().queuedMessages.length > 0);
    const submissionId = pending?.id ?? (retryFailedSubmission ? undefined : inputId) ?? uuidv4();
    if (recovered) {
      if (recovered.ok === false) {
        updateConversationDraft(this.id, { pendingSubmission: undefined }, { submissionId });
        throw new Error(recovered.reason ?? 'Message was not queued.');
      }
      await this.load({ force: true });
      updateConversationDraft(
        this.id,
        { pendingSubmission: undefined, pendingInput: undefined, error: undefined },
        { submissionId }
      );
      this.clearSentContext(staged);
      return { runId: String(recovered.run_id ?? '') };
    }
    updateConversationDraft(this.id, {
      pendingSubmission: {
        id: submissionId,
        signature,
        queued,
        variables: submissionVariables,
        executionTarget: submissionTarget,
        stagedContext: staged,
      },
    });
    await flushConversationDrafts(this.id);
    this.assertReady(environmentRevision, inputId);
    if (queued) {
      const result =
        recovered ??
        (await this.client.enqueueMessage(this.id, agentPrompt, {
          triggerRun: true,
          role: 'user',
          variables: submissionVariables,
          source: 'ui',
          inputContent: content,
          submissionId,
        }));
      if (!result.ok) {
        updateConversationDraft(this.id, { pendingSubmission: undefined }, { submissionId });
        throw new Error(result.reason ?? 'Message was not queued. Please retry.');
      }
      updateConversationDraft(
        this.id,
        { pendingSubmission: undefined, pendingInput: undefined, error: undefined },
        { submissionId }
      );
      this.clearSentContext(staged);
      if (options.workspaceSupported) {
        this.panels.set('workspaceLocked', true);
      }
      return { runId: '' };
    }
    this.receive({ type: 'SUBMIT', text, attachments, stagedContext: staged });
    try {
      const target = submissionTarget;
      const result =
        recovered ??
        (await this.client.startRun(
          agentPrompt,
          target
            ? {
                mode: 'explicit',
                environment_id: target.environmentId,
                environment_generation: target.environmentGeneration,
              }
            : { mode: 'none' },
          this.id,
          submissionVariables,
          content,
          submissionId
        ));
      updateConversationDraft(
        this.id,
        { pendingSubmission: undefined, pendingInput: undefined, error: undefined },
        { submissionId }
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
