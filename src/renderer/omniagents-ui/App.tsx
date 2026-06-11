import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { waitFor } from 'xstate';

import {
  createCursorAssigner,
  fullEntry,
  lastEntrySignal,
  type SessionController,
  transcriptPage,
} from '@/renderer/services/session-control';
import { clearColumnActivity, publishColumnActivity } from '@/renderer/services/column-activity';
import { persistedStoreApi } from '@/renderer/services/store';
import { forwardEvent, registerColumnActor } from '@/renderer/services/supervisor-bridge';
import { VoiceScopeContext } from '@/renderer/services/voice-recording';
import type { TicketId } from '@/shared/types';

import type { PendingMessage } from './ChatShell';
import { type ArtifactItem, ArtifactsPanel } from './components/ArtifactsPanel';
import { BashJobs, type BashJobsKillResult, type BashJobsTailResult, type BashJobSummary } from './components/BashJobs';
import { Header } from './components/Header';
import { Input } from './components/Input';
import { ArtifactPortalProvider, type Attachment, MessageList } from './components/MessageList';
import { QueuedMessages } from './components/QueuedMessages';
import { GoalPanel, type GoalSnapshot } from './components/GoalPanel';
import { WakeupPanel, type WakeupSnapshot } from './components/WakeupPanel';
import { WorkersPanel, type WorkerSummary, type WorkersKillResult } from './components/WorkersPanel';
import { ResizableDivider } from './components/ResizableDivider';
import { type SessionItem, SessionList } from './components/SessionList';
import { Sidebar } from './components/Sidebar';
import { Tasks, type TaskSummary } from './components/Tasks';
import { Notifications, type NotificationInfo } from './components/Notifications';
import { RecapPanel, type RecapInfo } from './components/RecapPanel';
import { EscalationBanner, type EscalationInfo } from './components/EscalationBanner';
import { WorkspacePicker } from './components/WorkspacePicker';
import { OmniAgentsHeaderActionsPortal, OmniAgentsHeaderActionsProvider } from './header-actions';
import { useChatBoot } from './hooks/use-chat-boot';
import { useChatSession } from './hooks/use-chat-session';
import { useRPCClient, useRPCConnected } from './rpc-context';
import { useUiConfig } from './ui-config';

type UIState = 'connecting' | 'resume' | 'chat' | 'error';

export type ClientToolCallHandler = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: Record<string, unknown> }>;

export function App({
  sessionId: sessionIdProp,
  onSessionChange,
  variables: variablesProp,
  voiceVariables,
  greeting,
  suggestions,
  onReady,
  headerActionsTargetId,
  headerActionsCompact,
  pendingMessages,
  sandboxLabel: sandboxLabelProp,
  sandboxOptions,
  currentSandboxProfile,
  onSandboxChange,
  onClientToolCall,
  onController,
  onRunEnd,
  onRunStarted,
  pendingPlan,
  onPlanDecision,
  ticketId,
  workspaceDir,
}: {
  sessionId?: string;
  onSessionChange?: (sessionId: string | undefined) => void;
  variables?: Record<string, unknown>;
  voiceVariables?: Record<string, unknown>;
  greeting?: string;
  /** One-tap example tasks shown on the empty conversation. */
  suggestions?: ReadonlyArray<{ label: string; prompt: string }>;
  onReady?: () => void;
  headerActionsTargetId?: string;
  headerActionsCompact?: boolean;
  pendingMessages?: PendingMessage[];
  sandboxLabel?: string;
  sandboxOptions?: { value: string; label: string }[];
  currentSandboxProfile?: string;
  onSandboxChange?: (value: string) => void;
  onClientToolCall?: ClientToolCallHandler;
  onController?: (controller: SessionController | null) => void;
  onRunEnd?: (info: { runId?: string; reason?: string }) => void;
  onRunStarted?: (runId: string) => void;
  pendingPlan?: import('@/shared/chat-types').PlanItem | null;
  onPlanDecision?: (approved: boolean) => void;
  ticketId?: TicketId;
  workspaceDir?: string;
}) {
  const uiConfig = useUiConfig();
  const launcherStore = useStore(persistedStoreApi.$atom);
  const [ui, setUI] = useState<UIState>('connecting');
  const client = useRPCClient();
  // Stable refs so the run_started/run_end subscriptions (set up once) always
  // call the latest callbacks without re-subscribing.
  const onRunEndRef = useRef(onRunEnd);
  onRunEndRef.current = onRunEnd;
  const onRunStartedRef = useRef(onRunStarted);
  onRunStartedRef.current = onRunStarted;
  const connected = useRPCConnected();
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [_usageTotals, setUsageTotals] = useState<any | undefined>(undefined);
  const [_usageDelta, setUsageDelta] = useState<any | undefined>(undefined);
  const [_modelInfo, setModelInfo] = useState<
    { model?: string; max_input_tokens?: number; max_output_tokens?: number } | undefined
  >(undefined);
  const [agentName, setAgentName] = useState<string>('OmniAgent');
  const [welcomeText, setWelcomeText] = useState<string | undefined>(undefined);
  const normalizeAgentName = useCallback((name: string) => {
    let s = String(name || '').trim();
    s = s.replace(/[_-]+/g, ' ');
    s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    s = s.replace(/\s+/g, ' ');
    return s
      .split(' ')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ''))
      .join(' ')
      .trim();
  }, []);

  const [initialSent, setInitialSent] = useState(false);
  const urlSessionHandledRef = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [artifactsPanelOpen, setArtifactsPanelOpen] = useState(false);
  const [artifactsPanelWidth, setArtifactsPanelWidth] = useState(() => {
    try {
      const stored = localStorage.getItem('artifacts-panel-width');
      return stored ? parseInt(stored, 10) : 240;
    } catch {
      return 240;
    }
  });
  const [isLargeScreen, setIsLargeScreen] = useState(() => window.innerWidth >= 1024);
  const [minimalMode] = useState(() => uiConfig.minimal);
  const [workspaceSupported, setWorkspaceSupported] = useState(false);
  // Seed from the workspaceDir prop the launcher passes down for project-scoped
  // surfaces (Code tab). The chat-boot RPC still runs after connect to confirm
  // and refresh — but the chip avoids flashing "Select workspace" while the
  // round-trip is in flight.
  const [workspacePath, setWorkspacePath] = useState<string | null>(workspaceDir ?? null);
  // Keep workspacePath aligned with the prop when the launcher swaps the
  // project under us (e.g. moving a tab to a different project). The chat-boot
  // / session-restore RPCs will overwrite it again once they resolve; this
  // just keeps the visual in sync until then.
  useEffect(() => {
    if (workspaceDir) {
      setWorkspacePath(workspaceDir);
    }
  }, [workspaceDir]);
  const [workspaceLocked, setWorkspaceLocked] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  // Background-bash live override: `ui.bash_jobs.update` broadcasts (and the
  // kill/tail/list server calls below) push a fresh snapshot here. When non-
  // null this takes precedence over the snapshot derived from tool_result
  // metadata in `items`. Reset to null on session change so the new session
  // starts from its own history-derived state.
  const [liveBashJobs, setLiveBashJobs] = useState<BashJobSummary[] | null>(null);
  const [goalSnapshot, setGoalSnapshot] = useState<GoalSnapshot | null>(null);
  const [wakeupSnapshot, setWakeupSnapshot] = useState<WakeupSnapshot | null>(null);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  // Dismissed IDs for each docked panel. Snapshotted on user submit:
  // every item currently in a terminal state gets added so it disappears
  // from the panel when the next run begins. Items spawned during the
  // new run aren't in the set yet, so they show normally; when THEY
  // exit they remain visible until the user's next submit. Reset on
  // session change so a fresh session starts clean.
  const [dismissedWorkerIds, setDismissedWorkerIds] = useState<Set<string>>(new Set());
  const [dismissedJobIds, setDismissedJobIds] = useState<Set<string>>(new Set());
  const [dismissedTaskIds, setDismissedTaskIds] = useState<Set<string>>(new Set());
  // Notifications accumulate from the agent's `notify` builtin calls;
  // dismissed manually via the docked panel buttons.
  const [notifications, setNotifications] = useState<NotificationInfo[]>([]);
  // Most recent session recap (from /recap or a programmatic trigger).
  // Single-slot — a new recap replaces the old; dismissible.
  const [recap, setRecap] = useState<RecapInfo | null>(null);
  // Pending agent escalation — the next user submit becomes the reply.
  const [escalation, setEscalation] = useState<EscalationInfo | null>(null);
  // Element backing the maximized-artifact portal. Callback ref triggers a
  // re-render when the chat-column wrapper attaches/detaches.
  const [chatColumnEl, setChatColumnEl] = useState<HTMLDivElement | null>(null);
  const [runActive, setRunActive] = useState(false);
  const [initialSessionParam] = useState<string | undefined>(() => uiConfig.session);
  const [queuedMessages, setQueuedMessages] = useState<import('./rpc/client').QueuedMessage[]>([]);
  const readyRef = useRef(false);
  const onClientToolCallRef = useRef(onClientToolCall);
  // Armed by the mic button so the next run (and only that run) gets the speak tool.
  const voiceRunRef = useRef(false);
  useEffect(() => {
    onClientToolCallRef.current = onClientToolCall;
  }, [onClientToolCall]);
  const onSessionChangeRef = useRef(onSessionChange);
  useEffect(() => {
    onSessionChangeRef.current = onSessionChange;
  }, [onSessionChange]);
  useEffect(() => {
    readyRef.current = false;
  }, [uiConfig.uiUrl]);

  // Chat session state machine — manages items, sessionId, runId, thinking,
  // status, preamble, tool status, and approval state.
  const machine = useChatSession(client);
  const {
    actor,
    items,
    thinking,
    status,
    statusSpinner,
    statusItalic,
    preamble,
    toolStatus,
    runId,
    sessionId,
    stagedContext,
    submit,
    submitError,
    stop,
    loadSession,
    selectSession,
    historyLoaded,
    historyError,
    newSession,
    approvalDecided,
    appendResponse,
    addArtifact,
    setSessionId,
    stageContext,
    clearStagedContext,
  } = machine;

  // Boot orchestrator — composes server → RPC → bootstrap → session load into
  // a single state machine with automatic teardown on disconnect. Replaces the
  // imperative mount-effect chain that used to live here.
  const initialBootSessionId = sessionIdProp || uiConfig.searchParams.get('session') || undefined;
  const bootState = useChatBoot({
    client,
    chatSession: machine,
    sessionId: initialBootSessionId,
    wsRealtimeUrl: uiConfig.wsRealtimeUrl,
    token: uiConfig.token,
  });

  const refreshSessions = useCallback(async () => {
    try {
      const list = await client.listSessions();
      setSessions(list);
    } catch {}
  }, [client]);

  // Publish this column's live activity (thinking / tool line / pending
  // approval) so deck chrome can show a glanceable "now doing X" without
  // reaching into the transcript. Scoped by the same context the voice
  // system uses (the Code tab id; CHAT_VOICE_SCOPE on the Chat tab).
  const activityScope = useContext(VoiceScopeContext);
  const pendingApproval = useMemo(
    () => items.some((it) => (it as { type?: string }).type === 'approval'),
    [items]
  );
  useEffect(() => {
    if (!activityScope) {
      return;
    }
    publishColumnActivity(activityScope, {
      thinking: !!thinking,
      text: toolStatus || status || null,
      pendingApproval,
    });
  }, [activityScope, thinking, toolStatus, status, pendingApproval]);
  useEffect(() => {
    if (!activityScope) {
      return;
    }
    return () => clearColumnActivity(activityScope);
  }, [activityScope]);

  // Sync capabilities from the boot machine into local state. The boot
  // machine is the source of truth; these local useStates exist because
  // downstream components consume them as plain values and some (like
  // workspacePath) are also updated by session selection post-boot.
  useEffect(() => {
    const caps = bootState.capabilities;
    if (!caps) {
      return;
    }
    setAgentName(caps.agentName);
    setWelcomeText(caps.welcomeText);
    setVoiceEnabled(caps.voiceEnabled);
    setWorkspaceSupported(caps.workspaceSupported);
    if (caps.workspacePath) {
      setWorkspacePath(caps.workspacePath);
    }
    // Note: the host window title (index.html "Omni Code") is left alone —
    // overwriting it with the agent name made the title flip between tabs.
  }, [bootState.capabilities]);

  // React to boot phase → drive the top-level UI mode. In resume mode
  // (user explicitly asked to pick a session), show the session list
  // once bootstrap is done. Otherwise, show chat as soon as boot is
  // ready.
  useEffect(() => {
    if (bootState.phase === 'bootstrapError') {
      setUI('error');
      return;
    }
    if (!bootState.ready) {
      return;
    }
    const resume = uiConfig.searchParams.get('resume') === 'true';
    const sid = sessionIdProp || uiConfig.searchParams.get('session') || undefined;
    if (resume && !sid) {
      client
        .listSessions()
        .then((list) => setSessions(list))
        .catch(() => {});
      setUI('resume');
    } else {
      setUI('chat');
    }
  }, [bootState.phase, bootState.ready, client, sessionIdProp, uiConfig.searchParams]);

  // Side-effect-only listeners for events the machine doesn't handle
  // (session state + filtering is handled by the useChatSession hook).
  // These run for the lifetime of the component and are independent of
  // the boot machine — they need to be live even before boot completes
  // so that any early events aren't lost.
  useEffect(() => {
    const offQueueChanged = client.on('queue_changed', (p: any) => {
      // Server broadcasts a full snapshot (small queue, simple to apply).
      // Only accept events targeted at the currently-loaded session so a
      // stale ``queue_changed`` from a session we just switched away from
      // doesn't poison the panel.
      const liveSessionId = actor.getSnapshot().context.sessionId;
      if (typeof p?.session_id === 'string' && p.session_id !== liveSessionId) {
        return;
      }
      setQueuedMessages(Array.isArray(p?.items) ? p.items : []);
    });
    const offRunStarted = client.on('run_started', (p: any) => {
      setRunActive(true);
      setRecap(null);
      try {
        if (typeof p?.run_id === 'string') {
          onRunStartedRef.current?.(p.run_id);
        }
      } catch {}
      onSessionChangeRef.current?.(actor.getSnapshot().context.sessionId);
      refreshSessions();
    });
    const offRunEnd = client.on('run_end', (p: any) => {
      setRunActive(false);
      try {
        const usage = p?.usage || {};
        const info = {
          model: p?.model,
          max_input_tokens: p?.max_input_tokens,
          max_output_tokens: p?.max_output_tokens,
        };
        setModelInfo(info);
        setUsageTotals(usage);
      } catch {}
      try {
        onRunEndRef.current?.({
          runId: typeof p?.run_id === 'string' ? p.run_id : undefined,
          reason: String(p?.end_reason ?? 'completed'),
        });
      } catch {}
      refreshSessions();
    });
    const offToken = client.on('token', (p: any) => {
      try {
        setUsageDelta(p?.delta);
        setUsageTotals(p?.totals);
        setModelInfo({
          model: p?.model,
          max_input_tokens: p?.max_input_tokens,
          max_output_tokens: p?.max_output_tokens,
        });
      } catch {}
    });
    // Single dispatcher for every `client_request` the server sends.
    //   - ui.add_artifact → local artifact panel
    //   - tool.call → local client-tool handler (works in every mode — autopilot
    //     agents share the same path as user-initiated agents)
    // `ui.set_status` is handled by use-chat-session.ts. Tool approvals
    // are now on the dedicated `tool_approval_requested` event (omniagents
    // 0.16+), also wired in use-chat-session.ts — not on client_request.
    const offClientRequest = client.on('client_request', (p: any) => {
      const fn = String(p?.function ?? '');
      if (fn === 'ui.add_artifact') {
        const request_id = String(p?.request_id ?? '');
        const args = p?.args || {};
        addArtifact({
          title: typeof args?.title === 'string' ? args.title : '',
          content: typeof args?.content === 'string' ? args.content : '',
          mode: typeof args?.mode === 'string' ? args.mode : 'markdown',
          artifact_id: typeof args?.artifact_id === 'string' ? args.artifact_id : undefined,
          session_id: typeof p?.session_id === 'string' ? p.session_id : undefined,
        });
        if (request_id) {
          client.clientResponse(request_id, true, { ack: true }).catch(() => {});
        }
        return;
      }
      if (fn === 'ui.bash_jobs.update') {
        const request_id = String(p?.request_id ?? '');
        const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined;
        const currentSessionId = actor.getSnapshot().context.sessionId;
        if (eventSessionId && currentSessionId && currentSessionId !== eventSessionId) {
          if (request_id) {
            client.clientResponse(request_id, true, { ack: true }).catch(() => {});
          }
          return;
        }
        const args = p?.args || {};
        const snap = args?.snapshot;
        if (Array.isArray(snap)) {
          setLiveBashJobs(snap as BashJobSummary[]);
        }
        if (request_id) {
          client.clientResponse(request_id, true, { ack: true }).catch(() => {});
        }
        return;
      }
      if (fn === 'ui.workers.update') {
        // Broadcast from omni-code's worker spawn / completion hooks.
        // Snapshot is the full per-session workers list; replace state
        // wholesale.
        const request_id = String(p?.request_id ?? '');
        const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined;
        const currentSessionId = actor.getSnapshot().context.sessionId;
        if (eventSessionId && currentSessionId && currentSessionId !== eventSessionId) {
          if (request_id) {
            client.clientResponse(request_id, true, { ack: true }).catch(() => {});
          }
          return;
        }
        const args = p?.args || {};
        const snap = args?.snapshot;
        if (Array.isArray(snap)) {
          setWorkers(snap as WorkerSummary[]);
        }
        if (request_id) {
          client.clientResponse(request_id, true, { ack: true }).catch(() => {});
        }
        return;
      }
      if (fn === 'tool.call') {
        const request_id = String(p?.request_id ?? '');
        if (!request_id) {
          return;
        }
        const args = (p?.args || {}) as Record<string, unknown>;
        const toolName = String(args.tool ?? '');
        const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;
        if (!onClientToolCallRef.current) {
          client
            .clientResponse(request_id, false, undefined, { message: 'No client tool handler registered' })
            .catch(() => {});
          return;
        }
        onClientToolCallRef
          .current(toolName, toolArgs)
          .then((res) => {
            client.clientResponse(request_id, res.ok, res.result, res.error).catch(() => {});
          })
          .catch((err: Error) => {
            client.clientResponse(request_id, false, undefined, { message: err.message }).catch(() => {});
          });
        return;
      }
      if (fn === 'notify') {
        // Agent ``notify`` builtin — fire-and-forget heads-up. Push to
        // the docked notifications panel and ack immediately; the user
        // dismisses manually via the panel buttons.
        const request_id = String(p?.request_id ?? '');
        const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined;
        const currentSessionId = actor.getSnapshot().context.sessionId;
        if (eventSessionId && currentSessionId && currentSessionId !== eventSessionId) {
          if (request_id) {
            client.clientResponse(request_id, true, { ack: true }).catch(() => {});
          }
          return;
        }
        const args = p?.args || {};
        const message = typeof args?.message === 'string' ? args.message : '';
        if (message) {
          setNotifications((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              message,
              timestamp: Date.now(),
            },
          ]);
        }
        if (request_id) {
          client.clientResponse(request_id, true, { ack: true }).catch(() => {});
        }
        return;
      }
      if (fn === 'ui.recap') {
        // Session recap pushed from the server (/recap or a programmatic
        // trigger). Single-slot panel; newest replaces any prior recap.
        const request_id = String(p?.request_id ?? '');
        const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined;
        const currentSessionId = actor.getSnapshot().context.sessionId;
        if (eventSessionId && currentSessionId && currentSessionId !== eventSessionId) {
          if (request_id) {
            client.clientResponse(request_id, true, { ack: true }).catch(() => {});
          }
          return;
        }
        const args = p?.args || {};
        const text = typeof args?.text === 'string' ? args.text : '';
        if (text) {
          setRecap({ text, timestamp: Date.now() });
        }
        if (request_id) {
          client.clientResponse(request_id, true, { ack: true }).catch(() => {});
        }
        return;
      }
      if (fn === 'ui.goal.update') {
        // Two consumers for the /goal autopilot snapshot:
        //   1. The local GoalPanel chip rendered above the input — every
        //      chat surface (Chat tab, Spaces Agent Session) gets the
        //      visible status indicator.
        //   2. main's SupervisorOrchestrator — Tickets-only path that
        //      maps active/completed/cancelled onto the ticket's phase.
        // Always ack so the omniagents server doesn't hang.
        const request_id = String(p?.request_id ?? '');
        const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined;
        const currentSessionId = actor.getSnapshot().context.sessionId;
        if (eventSessionId && currentSessionId && currentSessionId !== eventSessionId) {
          if (request_id) {
            client.clientResponse(request_id, true, { ack: true }).catch(() => {});
          }
          return;
        }
        const args = p?.args || {};
        const snap = args?.snapshot;
        if (snap === null || snap === undefined) {
          setGoalSnapshot(null);
        } else if (typeof snap === 'object') {
          setGoalSnapshot(snap as GoalSnapshot);
        }
        if (ticketId) {
          void forwardEvent({
            kind: 'goal-update',
            ticketId,
            snapshot: snap === null || snap === undefined ? null : (snap as any),
          });
        }
        if (request_id) {
          client.clientResponse(request_id, true, { ack: true }).catch(() => {});
        }
        return;
      }
      if (fn === 'ui.wakeup.update') {
        // schedule_wakeup tick loop snapshot. Fired on start, every tick,
        // and on cancel/exhaustion. snapshot=null means torn down (panel
        // clears). Source: omni-code server_functions/wakeup.py. No ticket
        // mapping — just refresh the local WakeupPanel chip.
        const request_id = String(p?.request_id ?? '');
        const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined;
        const currentSessionId = actor.getSnapshot().context.sessionId;
        if (eventSessionId && currentSessionId && currentSessionId !== eventSessionId) {
          if (request_id) {
            client.clientResponse(request_id, true, { ack: true }).catch(() => {});
          }
          return;
        }
        const args = p?.args || {};
        const snap = args?.snapshot;
        if (snap === null || snap === undefined) {
          setWakeupSnapshot(null);
        } else if (typeof snap === 'object') {
          setWakeupSnapshot(snap as WakeupSnapshot);
        }
        if (request_id) {
          client.clientResponse(request_id, true, { ack: true }).catch(() => {});
        }
        return;
      }
      if (fn === 'escalate') {
        // Agent ``escalate`` builtin — blocking. Surface the banner and
        // intentionally do NOT call clientResponse here; the next user
        // submit reads the pending escalation, sends the reply via
        // clientResponse, and clears the banner.
        const request_id = String(p?.request_id ?? '');
        const eventSessionId = typeof p?.session_id === 'string' ? p.session_id : undefined;
        const currentSessionId = actor.getSnapshot().context.sessionId;
        if (eventSessionId && currentSessionId && currentSessionId !== eventSessionId) {
          if (request_id) {
            client.clientResponse(request_id, true, { ack: true }).catch(() => {});
          }
          return;
        }
        const args = p?.args || {};
        const message = typeof args?.message === 'string' ? args.message : '';
        const runIdArg = typeof p?.run_id === 'string' ? p.run_id : undefined;
        if (!request_id) {
          return;
        }
        setEscalation({
          request_id,
          message,
          session_id: eventSessionId,
          run_id: runIdArg,
        });
        return;
      }
    });

    return () => {
      offQueueChanged();
      offRunStarted();
      offRunEnd();
      offClientRequest();
      offToken();
      client.disconnect();
    };
  }, [client, actor, addArtifact, refreshSessions]);

  // Derive artifact index from the items stream (artifacts are now inline in conversation)
  const visibleArtifacts = useMemo(() => {
    return items.filter((it): it is ArtifactItem => it.type === 'artifact');
  }, [items]);

  // Derive Tasks + BashJobs from the items stream — every tool_result whose
  // metadata carries a `tasks_snapshot` / `bash_jobs_snapshot` overwrites the
  // running snapshot, so the latest one wins. This makes the panels self-
  // populating on session load (history replay) without a separate listener.
  const { rawTasks, tasks, derivedBashJobs } = useMemo(() => {
    let lastTasks: TaskSummary[] = [];
    let lastJobs: BashJobSummary[] = [];
    for (const it of items) {
      if (it.type !== 'tool') {
        continue;
      }
      const md = (it as { metadata?: { tasks_snapshot?: unknown; bash_jobs_snapshot?: unknown } }).metadata;
      if (Array.isArray(md?.tasks_snapshot)) {
        lastTasks = md.tasks_snapshot as TaskSummary[];
      }
      if (Array.isArray(md?.bash_jobs_snapshot)) {
        lastJobs = md.bash_jobs_snapshot as BashJobSummary[];
      }
    }
    // Filter out completed tasks that were dismissed at the last user
    // submit, then apply the idle-mode "hide completed" rule on top so
    // the panel quiets down between runs.
    const liveTasks = lastTasks.filter((t) => !(t.status === 'completed' && dismissedTaskIds.has(t.id)));
    const filteredTasks = runActive ? liveTasks : liveTasks.filter((t) => t.status !== 'completed');
    return { rawTasks: lastTasks, tasks: filteredTasks, derivedBashJobs: lastJobs };
  }, [items, runActive, dismissedTaskIds]);

  // Live override (from ui.bash_jobs.update broadcasts and bash_jobs.* server
  // calls) takes precedence over history-derived state when present. Mirror
  // the Tasks behavior: while a run is active keep everything visible (minus
  // dismissed exits), and once idle drop successful exits but keep failures
  // (non-zero/null exit_code) visible until the user dismisses them.
  const bashJobs = useMemo(() => {
    const source = liveBashJobs ?? derivedBashJobs;
    const live = source.filter((j) => !(!j.running && dismissedJobIds.has(j.job_id)));
    return runActive ? live : live.filter((j) => j.running || j.exit_code !== 0);
  }, [liveBashJobs, derivedBashJobs, runActive, dismissedJobIds]);

  // Same shape for workers: drop dismissed exits, then idle-hide only
  // successful completions so failures (error/cancelled) stay visible
  // until the user dismisses them.
  const visibleWorkers = useMemo(() => {
    const live = workers.filter((w) => !(w.status !== 'running' && dismissedWorkerIds.has(w.worker_id)));
    return runActive ? live : live.filter((w) => w.status !== 'completed');
  }, [workers, runActive, dismissedWorkerIds]);

  // Clear the live override on session change so the next session starts
  // from its own history-derived snapshot instead of the previous session's
  // last broadcast.
  useEffect(() => {
    setLiveBashJobs(null);
    // Workers panel has no history-derived seed (workers are runtime
    // only); clear so the prior session's list doesn't leak into the new
    // one until ``workers.list`` resolves below.
    setWorkers([]);
    // Reset dismissal sets on session change so a fresh session starts
    // with the panels showing their full server-side snapshot.
    setDismissedWorkerIds(new Set());
    setDismissedJobIds(new Set());
    setDismissedTaskIds(new Set());
  }, [sessionId]);

  const handleWorkerKill = useCallback(
    async (worker_id: string): Promise<WorkersKillResult> => {
      const res = (await client.serverCall('workers.kill', { worker_id }, sessionId)) as unknown as WorkersKillResult;
      if (Array.isArray(res?.snapshot)) {
        setWorkers(res.snapshot as WorkerSummary[]);
      }
      return res;
    },
    [client, sessionId]
  );

  const handleBashKill = useCallback(
    async (job_id: string): Promise<BashJobsKillResult> => {
      const res = (await client.serverCall('bash_jobs.kill', { job_id }, sessionId)) as unknown as BashJobsKillResult;
      if (Array.isArray(res?.snapshot)) {
        setLiveBashJobs(res.snapshot);
      }
      return res;
    },
    [client, sessionId]
  );

  const handleBashTail = useCallback(
    async (job_id: string, lines?: number): Promise<BashJobsTailResult> => {
      const args: Record<string, unknown> = { job_id };
      if (typeof lines === 'number') {
        args.lines = lines;
      }
      const res = (await client.serverCall('bash_jobs.tail', args, sessionId)) as unknown as BashJobsTailResult & {
        snapshot?: BashJobSummary[];
      };
      if (Array.isArray(res?.snapshot)) {
        setLiveBashJobs(res.snapshot);
      }
      return res;
    },
    [client, sessionId]
  );

  const handleBashWarmup = useCallback(async () => {
    const res = (await client.serverCall('bash_jobs.list', {}, sessionId)) as unknown as {
      snapshot?: BashJobSummary[];
    };
    if (Array.isArray(res?.snapshot)) {
      setLiveBashJobs(res.snapshot);
    }
  }, [client, sessionId]);

  const handleBashDismiss = useCallback((job_id: string) => {
    setDismissedJobIds((prev) => {
      const next = new Set(prev);
      next.add(job_id);
      return next;
    });
  }, []);

  const handleWorkerDismiss = useCallback((worker_id: string) => {
    setDismissedWorkerIds((prev) => {
      const next = new Set(prev);
      next.add(worker_id);
      return next;
    });
  }, []);

  const handleGoalDismiss = useCallback(() => setGoalSnapshot(null), []);
  const handleWakeupDismiss = useCallback(() => setWakeupSnapshot(null), []);

  useEffect(() => {
    const handler = () => setIsLargeScreen(window.innerWidth >= 1024);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('artifacts-panel-width', String(artifactsPanelWidth));
    } catch {}
  }, [artifactsPanelWidth]);

  // Scroll to an inline artifact in the conversation stream
  const handleScrollToArtifact = useCallback((artifactId: string) => {
    setArtifactsPanelOpen(false);
    const el = document.querySelector(`[data-artifact-id="${CSS.escape(artifactId)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-primary', 'rounded-lg');
      setTimeout(() => el.classList.remove('ring-2', 'ring-primary', 'rounded-lg'), 1500);
    }
  }, []);

  // moved below handleSubmit

  const handleSubmit = useCallback(
    async (
      text: string,
      files?: File[],
      runOverrides?: import('@/shared/types').RunOverrides
    ): Promise<{ runId: string } | undefined> => {
      // Dismiss successfully-completed items from each docked panel so the
      // next run starts with a clean dock. Failures (worker error/cancelled,
      // non-zero/null bash exit) stick until the user dismisses them so a
      // quietly-failed background task isn't lost behind the next prompt.
      // Items spawned during the new run aren't in the set yet and will stay
      // visible until the user's next submit. Fires for slash commands too
      // — a slash is still a user-initiated step boundary.
      setDismissedWorkerIds((prev) => {
        const next = new Set(prev);
        for (const w of workers) {
          if (w.status === 'completed') next.add(w.worker_id);
        }
        return next;
      });
      setDismissedJobIds((prev) => {
        const next = new Set(prev);
        const source = liveBashJobs ?? derivedBashJobs;
        for (const j of source) {
          if (!j.running && j.exit_code === 0) next.add(j.job_id);
        }
        return next;
      });
      setDismissedTaskIds((prev) => {
        const next = new Set(prev);
        for (const t of rawTasks) {
          if (t.status === 'completed') next.add(t.id);
        }
        return next;
      });
      setGoalSnapshot((prev) => {
        if (prev?.status === 'completed' || prev?.status === 'cancelled') {
          return null;
        }
        return prev;
      });

      // Escalation reply: when the agent is paused on an ``escalate``
      // tool call, route the user's next message back as the reply via
      // client_response (and clear the banner) instead of starting a
      // new run. Slash commands pass through so the user can still
      // issue /goal.stop, /help, etc. mid-escalation.
      if (escalation && !text.startsWith('/')) {
        const pending = escalation;
        setEscalation(null);
        try {
          await client.clientResponse(pending.request_id, true, { reply: text });
        } catch {}
        return undefined;
      }

      // Slash commands
      if (text.startsWith('/')) {
        const parts = text.trim().split(/\s+/);
        const name = parts[0].slice(1);
        const argText = text.slice(parts[0].length).trim();
        try {
          // Anchor the session's workspace_root before dispatching the
          // server function. Slash commands like ``/goal`` trigger
          // ``start_run`` server-side via ``enqueue_message`` + drainer
          // (the autopilot path bypasses our regular ``startRun(variables)``
          // call), so the session has to already carry ``workspace_root``
          // by the time the run kicks off — otherwise the framework raises
          // ``WorkspaceRootRequiredError``. The unknown-slash fallback
          // below also routes through ``startRun`` / ``enqueueMessage``
          // without variables, so we set it once for every slash path.
          //
          // Source priority: local ``workspacePath`` state first. It's
          // seeded synchronously from the ``workspaceDir`` prop (line 77),
          // refreshed by the boot caps effect (line 161), AND updated by
          // ``WorkspacePicker.onSelect`` (line 1338) — so a user changing
          // the workspace via the pill *before* hitting submit is
          // respected here. Boot capabilities only win when local state
          // hasn't been seeded (no prop + boot raced React's flush).
          const sid = actor.getSnapshot().context.sessionId ?? sessionId;
          const caps = bootState.actor.getSnapshot().context.capabilities as
            | { workspacePath?: string | null; workspaceSupported?: boolean }
            | undefined;
          const liveWorkspacePath = workspacePath || caps?.workspacePath || null;
          const liveWorkspaceSupported = workspaceSupported || !!caps?.workspaceSupported;
          if (sid && liveWorkspacePath && liveWorkspaceSupported) {
            try {
              await client.serverCall('session.ensure', {
                session_id: sid,
                workspace_root: liveWorkspacePath,
              });
            } catch {
              /* best-effort — let the server function attempt the run anyway */
            }
          }
          const funcs = await client.listServerFunctions();
          const found = funcs.find((f) => String(f.name).toLowerCase() === name.toLowerCase());
          if (!found) {
            // Not a known server function; send to LLM. Queue instead of
            // starting directly when a run is already active or the queue
            // is non-empty — same guard as the main path below.
            if (runActive || queuedMessages.length > 0) {
              const sid = actor.getSnapshot().context.sessionId ?? sessionId;
              if (sid) {
                await client.enqueueMessage(sid, text, { triggerRun: true, role: 'user', source: 'ui' });
              }
            } else {
              await client.startRun(text, sessionId);
            }
            return;
          }
          let args: Record<string, unknown> = {};
          if (argText) {
            try {
              const parsed = JSON.parse(argText);
              if (typeof parsed === 'object' && !Array.isArray(parsed)) {
                args = parsed;
              } else if (Array.isArray(parsed)) {
                args = { args: parsed };
              } else if (typeof parsed === 'string') {
                args = { text: parsed };
              } else {
                args = { value: parsed };
              }
            } catch {
              args = { text: argText };
            }
          }
          const result = await client.serverCall(name, args, sessionId);
          // /recap renders in the docked RecapPanel via the ui.recap
          // broadcast — don't also dump it into the chat transcript. The
          // return value carries the text as a fallback if the broadcast
          // was dropped.
          if (name.toLowerCase() === 'recap') {
            const text =
              typeof (result as { text?: unknown })?.text === 'string' ? (result as { text: string }).text : '';
            if (text) {
              setRecap({ text, timestamp: Date.now() });
            }
            return;
          }
          const formatted = JSON.stringify(result, null, 2);
          appendResponse(formatted === 'null' ? 'Done.' : formatted);
          return;
        } catch (e) {
          appendResponse(`Error: ${String((e as Error)?.message || e)}`);
          return;
        }
      }
      try {
        // Read sessionId from the actor snapshot rather than the destructured
        // React state — the chat-session machine sets context.sessionId
        // synchronously when entering ready.idle, but the React render that
        // would update the destructured value may not have flushed yet when
        // the supervisor bridge calls us right after awaitChatReady() resolves.
        const liveSessionId = actor.getSnapshot().context.sessionId ?? sessionId;
        if (!liveSessionId) {
          submitError('No active session — loadSession must run first');
          return;
        }
        let content: any | undefined = undefined;
        let attachments: Attachment[] = [];
        if (files && files.length > 0) {
          const parts: any[] = [];
          if (text.trim().length > 0) {
            parts.push({ type: 'input_text', text });
          }
          const processed = await Promise.all(
            files.map(async (f) => {
              if (f.type && f.type.startsWith('image/')) {
                const dataUrl = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result || ''));
                  reader.onerror = () => reject(new Error('Failed to read image'));
                  reader.readAsDataURL(f);
                });
                return {
                  filePart: { type: 'input_image', image_url: dataUrl, detail: 'auto' },
                  attachment: { type: 'image' as const, url: dataUrl, filename: f.name, mime: f.type, size: f.size },
                };
              } else {
                const base64 = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => {
                    try {
                      const buf = reader.result as ArrayBuffer;
                      const bytes = new Uint8Array(buf);
                      let binary = '';
                      for (let i = 0; i < bytes.length; i++) {
                        binary += String.fromCharCode(bytes[i]);
                      }
                      resolve(btoa(binary));
                    } catch {
                      reject(new Error('Failed to encode file'));
                    }
                  };
                  reader.onerror = () => reject(new Error('Failed to read file'));
                  reader.readAsArrayBuffer(f);
                });
                const param: any = { type: 'input_file', file_data: base64 };
                if (f.name) {
                  param.filename = f.name;
                }
                return {
                  filePart: param,
                  attachment: { type: 'file' as const, filename: f.name, mime: f.type, size: f.size },
                };
              }
            })
          );
          parts.push(...processed.map((p) => p.filePart));
          attachments = processed.map((p) => p.attachment);
          content = parts;
        }
        // MCP-Apps ``ui/update-model-context``: prepend any staged context
        // blocks to the prompt the agent sees. Snapshot the staged entries
        // before clearing so we can attach them to the user-turn message
        // for visibility in the chat log.
        const stagedSnapshot = stagedContext.length > 0 ? stagedContext.slice() : undefined;
        const agentPrompt = stagedSnapshot ? `${stagedSnapshot.map((c) => c.text).join('\n\n')}\n\n${text}` : text;

        // Merge parent-provided variables (e.g. client_tools) with workspace
        // variables. Prefer the boot actor's capabilities snapshot over the
        // destructured React state — boot finishes synchronously inside xstate
        // (waitFor unblocks awaitChatReady), but the React state that mirrors
        // its capabilities into setWorkspacePath / setWorkspaceSupported may
        // not have flushed by the time the supervisor bridge submits the run.
        const caps = bootState.actor.getSnapshot().context.capabilities;
        const liveWorkspacePath = caps?.workspacePath ?? workspacePath;
        const liveWorkspaceSupported = caps?.workspaceSupported ?? workspaceSupported;
        const workspaceVars: Record<string, unknown> | undefined =
          liveWorkspacePath && liveWorkspaceSupported ? { workspace_root: liveWorkspacePath } : undefined;
        // One-shot voice arming: a submission from the mic button uses the
        // voice-enabled variables (speak tool + persona) for *this run only*;
        // every other run (typed, or another column) stays speak-free. The ref
        // is per-App-instance, so columns don't race.
        const useVoiceRun = voiceRunRef.current;
        voiceRunRef.current = false;
        const variablesSource = useVoiceRun && voiceVariables ? voiceVariables : variablesProp;
        const baseVariables: Record<string, unknown> | undefined =
          variablesSource || workspaceVars ? { ...variablesSource, ...workspaceVars } : undefined;
        // Merge per-dispatch overrides (from the orchestrator's bridge.run call)
        // on top of the column's locally owned variables. The orchestrator owns
        // autopilot mode and ships its run intent atomically with the dispatch,
        // so we never derive that state by reading a separate store.
        // additional_instructions is prepended (orchestrator framing first);
        // safe_tool_overrides is replaced wholesale.
        const variables: Record<string, unknown> | undefined = runOverrides
          ? {
              ...(baseVariables ?? {}),
              ...(runOverrides.additionalInstructions
                ? {
                    additional_instructions:
                      typeof baseVariables?.additional_instructions === 'string'
                        ? `${runOverrides.additionalInstructions}\n\n${baseVariables.additional_instructions}`
                        : runOverrides.additionalInstructions,
                  }
                : {}),
              ...(runOverrides.safeToolOverrides ? { safe_tool_overrides: runOverrides.safeToolOverrides } : {}),
            }
          : baseVariables;

        // Queue the message instead of starting a run directly when a run is
        // currently active or the queue is non-empty. The drainer on the
        // server side calls start_run for us once the current run finishes,
        // and the chat-session machine handles the resulting RUN_STARTED
        // from idle state (appending the user message via event.prompt).
        // Critical: skip the local ``submit()`` machine call on this path —
        // the machine is in ``running`` and would drop SUBMIT, while
        // appending an optimistic user item that would later be duplicated
        // when RUN_STARTED fires with the same prompt.
        const queueAhead = runActive || queuedMessages.length > 0;
        if (queueAhead) {
          await client.enqueueMessage(liveSessionId, agentPrompt, {
            triggerRun: true,
            role: 'user',
            variables,
            source: 'ui',
          });
          if (stagedSnapshot) {
            clearStagedContext();
          }
          if (workspaceSupported) {
            setWorkspaceLocked(true);
          }
          // No run_id yet — the drainer mints one when start_run fires.
          return { runId: '' };
        }

        // Direct-start path: machine submit() owns the optimistic user-item
        // append and the idle → starting transition.
        submit(text, attachments.length ? attachments : undefined, stagedSnapshot);
        if (stagedSnapshot) {
          clearStagedContext();
        }

        const startResult = await client.startRun(agentPrompt, liveSessionId, variables, content);
        if (workspaceSupported) {
          setWorkspaceLocked(true);
        }
        return { runId: String(startResult?.run_id ?? '') };
      } catch (e) {
        submitError(String((e as Error)?.message || 'Failed to start run'));
        return undefined;
      }
    },
    [
      client,
      sessionId,
      actor,
      bootState.actor,
      variablesProp,
      voiceVariables,
      submit,
      submitError,
      workspacePath,
      workspaceSupported,
      stagedContext,
      clearStagedContext,
      runActive,
      queuedMessages.length,
      escalation,
      workers,
      liveBashJobs,
      derivedBashJobs,
      rawTasks,
    ]
  );

  // Submit from the mic button: arm the speak tool for just this run.
  const handleVoiceSubmit = useCallback(
    (text: string) => {
      voiceRunRef.current = true;
      void handleSubmit(text);
    },
    [handleSubmit]
  );

  const handleStop = useCallback(() => {
    if (!runId) {
      return;
    }
    stop();
    client.stopRun(runId).catch(() => {});
  }, [client, stop, runId]);

  // ---------------------------------------------------------------------------
  // Supervisor bridge event forwarding. The Code column owns the session id;
  // main observes this narrow event stream to drive phase / retry / stall state.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ticketId) {
      return;
    }
    type RunEvent = {
      run_id?: unknown;
      end_reason?: unknown;
      content?: unknown;
      role?: unknown;
      tool_name?: unknown;
      total_token_usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown };
      input_tokens?: unknown;
      output_tokens?: unknown;
      total_tokens?: unknown;
    };
    const num = (v: unknown): number => Number(v ?? 0);
    const offs: Array<() => void> = [];

    offs.push(
      client.on('run_started', (raw: unknown) => {
        const p = (raw ?? {}) as RunEvent;
        const runId = String(p.run_id ?? '');
        forwardEvent({ kind: 'run-started', ticketId, runId });
      })
    );
    offs.push(
      client.on('run_end', (raw: unknown) => {
        const p = (raw ?? {}) as RunEvent;
        forwardEvent({ kind: 'run-end', ticketId, reason: String(p.end_reason ?? 'completed') });
      })
    );
    offs.push(
      client.on('message_output', (raw: unknown) => {
        const p = (raw ?? {}) as RunEvent;
        forwardEvent({
          kind: 'message',
          ticketId,
          content: String(p.content ?? ''),
          role: p.role === 'user' ? 'user' : 'assistant',
          toolName: typeof p.tool_name === 'string' ? p.tool_name : undefined,
        });
      })
    );
    offs.push(
      client.on('token_usage', (raw: unknown) => {
        const p = (raw ?? {}) as RunEvent;
        const u = p.total_token_usage ?? p;
        forwardEvent({
          kind: 'token-usage',
          ticketId,
          usage: {
            inputTokens: num(u.input_tokens),
            outputTokens: num(u.output_tokens),
            totalTokens: num(u.total_tokens),
          },
        });
      })
    );

    return () => {
      for (const off of offs) {
        off();
      }
    };
  }, [ticketId, client]);

  // ---------------------------------------------------------------------------
  // Supervisor bridge actor registration. This is the one path autopilot uses
  // to submit, send, stop, and reset runs through the live Code column.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!ticketId) {
      return;
    }

    const awaitChatReady = (): Promise<void> =>
      waitFor(
        actor,
        (s) => {
          const v = s.value;
          return typeof v === 'object' && v !== null && 'ready' in v && (v as { ready?: unknown }).ready === 'idle';
        },
        { timeout: 30_000 }
      ).then(() => undefined);

    const unregister = registerColumnActor({
      ticketId,
      // The bridge resolves the runId from `start_run`'s RPC response rather
      // than waiting for a `run_started` event. Event-based waits used to
      // live in a component-local ref, which lost waiters across React
      // StrictMode's mount → unmount → mount dance and stranded the bridge
      // dispatch in a 60s timeout. The RPC ack carries the same run_id.
      submit: async (prompt, runOverrides) => {
        await awaitChatReady();
        const result = await handleSubmit(prompt, undefined, runOverrides);
        if (!result?.runId) {
          throw new Error('start_run did not return a run_id');
        }
        return { runId: result.runId };
      },
      goalStart: async ({ prompt, maxTurns, tickInterval, runOverrides }) => {
        await awaitChatReady();
        // Mint a client-side session id if we don't have one yet. The
        // chat-session machine is the single mint point so we stay in
        // sync with its UUID.
        let sid = actor.getSnapshot().context.sessionId;
        if (!sid) {
          sid = await machine.loadSession(undefined);
        }

        // Assemble session.variables. For autopilot we know the
        // workspace dir definitively — the launcher provisioned a
        // worktree before calling startGoal and passed it down as the
        // ``workspaceDir`` prop. Prefer that over the boot machine's
        // capabilities snapshot (which may not have hydrated yet when
        // the autopilot button fires on a freshly-spawned tab) and over
        // ``workspaceSupported`` (which starts false and only flips
        // true after boot's first capabilities push).
        //
        // Fallback order: workspaceDir prop → bootState capabilities →
        // local workspacePath state.
        const caps = bootState.actor.getSnapshot().context.capabilities as
          | { workspacePath?: string | null; workspaceSupported?: boolean }
          | undefined;
        const liveWorkspacePath = workspaceDir ?? caps?.workspacePath ?? workspacePath;
        const workspaceVars: Record<string, unknown> | undefined = liveWorkspacePath
          ? { workspace_root: liveWorkspacePath }
          : undefined;
        const baseVariables: Record<string, unknown> = {
          ...((variablesProp as Record<string, unknown> | undefined) ?? {}),
          ...(workspaceVars ?? {}),
        };
        const variables: Record<string, unknown> = runOverrides
          ? {
              ...baseVariables,
              ...(runOverrides.additionalInstructions
                ? {
                    additional_instructions:
                      typeof baseVariables.additional_instructions === 'string'
                        ? `${runOverrides.additionalInstructions}\n\n${baseVariables.additional_instructions}`
                        : runOverrides.additionalInstructions,
                  }
                : {}),
              ...(runOverrides.safeToolOverrides ? { safe_tool_overrides: runOverrides.safeToolOverrides } : {}),
            }
          : baseVariables;

        await client.serverCall('session.ensure', {
          session_id: sid,
          variables,
        });
        // Kick off the /goal loop. The agent-side server function
        // enqueues the initial prompt, installs the tick, and registers
        // the run-end listener — launcher reacts via ui.goal.update.
        const goalArgs: Record<string, unknown> = { text: prompt };
        if (typeof maxTurns === 'number') {
          goalArgs.max_turns = maxTurns;
        }
        if (typeof tickInterval === 'number') {
          goalArgs.tick_interval = tickInterval;
        }
        await client.serverCall('goal', goalArgs, sid);
      },
      goalStop: async () => {
        const sid = actor.getSnapshot().context.sessionId;
        if (!sid) {
          return;
        }
        await client.serverCall('goal.stop', {}, sid).catch(() => {});
      },
      send: async (message) => {
        await awaitChatReady();
        await handleSubmit(message, undefined);
      },
      stop: async () => {
        const currentRunId = actor.getSnapshot().context.runId;
        if (currentRunId) {
          await client.stopRun(currentRunId).catch(() => {});
        }
        machine.stop();
      },
      reset: async () => {
        const currentRunId = actor.getSnapshot().context.runId;
        if (currentRunId) {
          await client.stopRun(currentRunId).catch(() => {});
        }
        machine.stop();
        await machine.loadSession(undefined);
      },
    });

    return () => {
      unregister();
    };
  }, [ticketId, client, machine, actor, handleSubmit]);

  useEffect(() => {
    if (!connected) {
      return;
    }
    if (ui !== 'chat') {
      return;
    }
    if (initialSent) {
      return;
    }
    // Only send initial message if there's no session param (session param is handled separately)
    const hasSessionParam = uiConfig.searchParams.has('session');
    if (hasSessionParam) {
      return;
    }
    const initial = uiConfig.searchParams.get('initial');
    if (initial && items.length === 0) {
      handleSubmit(initial);
      setInitialSent(true);
    }
  }, [connected, ui, initialSent, items.length, handleSubmit]);

  // Flush messages queued from ChatShell before the backend was ready
  const pendingFlushedRef = useRef(false);
  useEffect(() => {
    if (pendingFlushedRef.current) {
      return;
    }
    if (!connected || ui !== 'chat') {
      return;
    }
    if (!pendingMessages || pendingMessages.length === 0) {
      return;
    }
    pendingFlushedRef.current = true;
    for (const msg of pendingMessages) {
      handleSubmit(msg.text, msg.files);
    }
  }, [connected, ui, pendingMessages, handleSubmit]);

  const handleApprovalDecision = useCallback(
    async (request_id: string, value: 'yes' | 'always' | 'no', kind: 'function' | 'mcp' = 'function') => {
      // ``request_id`` is the model-minted identifier we stored on the
      // ApprovalItem when the approval event arrived (see
      // use-chat-session.ts):
      //   - kind 'function' → tool call_id  → tool_approval_response RPC
      //   - kind 'mcp'      → McpApprovalRequest id → mcp_approval_response RPC
      // Both take ``decision: "approve" | "reject"``; only the function
      // path honors ``always_approve``.
      const decision = value === 'no' ? 'reject' : 'approve';
      const alwaysApprove = value === 'always';
      const failureMessage = (e: unknown) => String((e as Error)?.message || 'failed');
      try {
        if (kind === 'mcp') {
          await client.mcpApprovalResponse(request_id, decision);
        } else {
          await client.toolApprovalResponse(request_id, decision, alwaysApprove);
        }
      } catch (e) {
        // Best-effort fallback: reject with the underlying error so the
        // run unblocks instead of hanging on the approval future.
        const reject =
          kind === 'mcp'
            ? client.mcpApprovalResponse(request_id, 'reject', failureMessage(e))
            : client.toolApprovalResponse(request_id, 'reject', false, failureMessage(e));
        await reject.catch(() => {});
      }
      approvalDecided(request_id, value);
    },
    [client, approvalDecided]
  );

  // Expose an imperative controller so the headless global orchestrator can
  // drive this column (send / approve / cancel) and read its run state via the
  // `column_*` tools. Refs keep the controller object stable while reading live
  // state each call. The parent (CodeWorkspaceLayout) registers it by tabId.
  // One cursor assigner per column, so transcript cursors are stable across
  // reads and survive approval removals / tool result updates.
  const cursorAssignerRef = useRef(createCursorAssigner());
  const ctrlStateRef = useRef<import('@/renderer/services/session-control').ColumnRunState>({
    running: false,
    awaitingApproval: [],
    transcript: { total: 0, latestCursor: null },
  });
  const cursors = cursorAssignerRef.current.assign(items);
  ctrlStateRef.current = {
    running: runActive,
    runId: runId ?? undefined,
    awaitingApproval: items
      .filter((i) => i.type === 'approval')
      .map((i) => {
        const a = i as { request_id: string; kind?: 'function' | 'mcp'; tool?: string };
        return { requestId: a.request_id, kind: a.kind ?? 'function', tool: a.tool };
      }),
    transcript: {
      total: items.length,
      latestCursor: items.length > 0 ? (cursors[items.length - 1] ?? null) : null,
      last: lastEntrySignal(items, cursors),
    },
  };
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;
  const handleStopRef = useRef(handleStop);
  handleStopRef.current = handleStop;
  const handleApprovalRef = useRef(handleApprovalDecision);
  handleApprovalRef.current = handleApprovalDecision;
  // Assigned after `handleSelectSession` is defined (below); kept in a ref so the
  // controller object stays stable.
  const newSessionRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!onController) {
      return;
    }
    const controller: SessionController = {
      getState: () => ctrlStateRef.current,
      getTranscript: (opts?: { after?: number; before?: number; limit?: number }) =>
        transcriptPage(itemsRef.current, cursorAssignerRef.current.assign(itemsRef.current), opts),
      getEntry: (cursor: number) =>
        fullEntry(itemsRef.current, cursorAssignerRef.current.assign(itemsRef.current), cursor),
      sendMessage: (text: string) => handleSubmitRef.current(text),
      stopRun: () => handleStopRef.current(),
      decideApproval: (requestId: string, decision: 'approve' | 'reject') => {
        const pending = ctrlStateRef.current.awaitingApproval.find((p) => p.requestId === requestId);
        return handleApprovalRef.current(requestId, decision === 'approve' ? 'yes' : 'no', pending?.kind ?? 'function');
      },
      newSession: () => newSessionRef.current(),
      notify: (content: string, source: string) =>
        // Deliver as a role="assistant" history item that triggers a run — the
        // exact wakeup the notification flusher uses internally. Uses the
        // existing `enqueue_message` RPC so it works against the released
        // runtime (no custom server function required).
        client.enqueueMessage(actor.getSnapshot().context.sessionId ?? '', content, {
          role: 'assistant',
          triggerRun: true,
          source,
        }),
    };
    onController(controller);
    return () => onController(null);
  }, [onController, client, actor]);

  const handleSelectSession = useCallback(
    async (id?: string, opts?: { fromProp?: boolean }) => {
      // loadSession owns the machine choreography AND the UUID mint for
      // new chats. It returns the resolved id so we can notify the parent.
      const resolvedId = await loadSession(id);
      if (!opts?.fromProp) {
        onSessionChange?.(resolvedId);
      }
      // Seed the Up-next panel from server state. ``queue_changed``
      // notifications will keep it in sync from here on.
      if (resolvedId) {
        try {
          const snap = await client.listQueue(resolvedId);
          setQueuedMessages(snap.items);
        } catch {
          setQueuedMessages([]);
        }
      } else {
        setQueuedMessages([]);
      }
      // Workspace restore is a side-effect of session selection, not part
      // of machine state — it stays here.
      if (id) {
        if (workspaceSupported) {
          try {
            const res = (await client.serverCall('fs_get_workspace_root', {}, id)) as any;
            if (res?.path) {
              setWorkspacePath(res.path);
            }
          } catch {}
          setWorkspaceLocked(true);
        }
      } else {
        setWorkspaceLocked(false);
        if (workspaceSupported) {
          try {
            // Match the chat-boot path: prefer the sandbox manifest root
            // over omni serve's host cwd so docker / remote sandboxes show
            // the path the agent's tools actually operate on.
            const res = (await client.serverCall('fs_get_workspace_root')) as any;
            if (res?.path) {
              setWorkspacePath(res.path);
            }
          } catch {}
        }
      }
      // Seed the /goal panel from server state on session bind. The
      // autopilot loop broadcasts ui.goal.update on every state change,
      // but if a goal is already running when we attach to this session
      // we need to pull the current snapshot so the panel renders
      // immediately instead of waiting for the next turn boundary.
      if (resolvedId) {
        try {
          const res = (await client.serverCall('goal.status', {}, resolvedId)) as { snapshot?: unknown } | undefined;
          const snap = res?.snapshot;
          setGoalSnapshot(snap && typeof snap === 'object' ? (snap as GoalSnapshot) : null);
        } catch {
          setGoalSnapshot(null);
        }
      } else {
        setGoalSnapshot(null);
      }
      // Seed the wakeup panel from server state. Same rationale as goal —
      // picks up a schedule that was already running before we attached.
      // wakeup.status may not be registered on every agent; silently
      // ignore so the panel stays empty.
      if (resolvedId) {
        try {
          const res = (await client.serverCall('wakeup.status', {}, resolvedId)) as { snapshot?: unknown } | undefined;
          const snap = res?.snapshot;
          setWakeupSnapshot(snap && typeof snap === 'object' ? (snap as WakeupSnapshot) : null);
        } catch {
          setWakeupSnapshot(null);
        }
      } else {
        setWakeupSnapshot(null);
      }
      // Seed the workers panel from server state. Same rationale as goal:
      // catches the case where workers were spawned earlier and are still
      // running when we attach.
      if (resolvedId) {
        try {
          const res = (await client.serverCall('workers.list', {}, resolvedId)) as { snapshot?: unknown } | undefined;
          const snap = res?.snapshot;
          setWorkers(Array.isArray(snap) ? (snap as WorkerSummary[]) : []);
        } catch {
          setWorkers([]);
        }
      } else {
        setWorkers([]);
      }
      setUI('chat');
    },
    [client, loadSession, workspaceSupported, onSessionChange]
  );
  // Controller `newSession` → fresh conversation (loadSession mints a new id).
  newSessionRef.current = () => void handleSelectSession(undefined);

  useEffect(() => {
    if (urlSessionHandledRef.current) {
      return;
    }
    if (!initialSessionParam) {
      return;
    }
    if (!connected) {
      return;
    }
    if (ui !== 'chat') {
      return;
    }
    urlSessionHandledRef.current = true;
    // Load session history, then send initial message only if session is empty
    (async () => {
      await handleSelectSession(initialSessionParam);
      const initial = uiConfig.searchParams.get('initial');
      if (initial && !initialSent) {
        // Check if session has history - if items is still empty after handleSelectSession, it's a new session
        // We need to check the actual history since handleSelectSession sets items
        try {
          const history = await client.getSessionHistory(initialSessionParam);
          if (history.length === 0) {
            handleSubmit(initial);
            setInitialSent(true);
          }
        } catch {
          // If we can't get history, assume it's new and send initial
          handleSubmit(initial);
          setInitialSent(true);
        }
      }
    })();
  }, [connected, ui, handleSelectSession, initialSessionParam, client, initialSent, handleSubmit]);

  // React to controlled sessionId prop changes from parent
  const prevSessionIdProp = useRef(sessionIdProp);
  useEffect(() => {
    if (sessionIdProp === prevSessionIdProp.current) {
      return;
    }
    prevSessionIdProp.current = sessionIdProp;
    if (!connected) {
      return;
    }
    const currentSessionId = actor.getSnapshot().context.sessionId;
    if (sessionIdProp && sessionIdProp !== currentSessionId) {
      handleSelectSession(sessionIdProp, { fromProp: true });
    } else if (!sessionIdProp && currentSessionId) {
      handleSelectSession(undefined, { fromProp: true });
    }
  }, [sessionIdProp, connected, handleSelectSession, actor]);

  useEffect(() => {
    if (!connected) {
      return;
    }
    refreshSessions();
  }, [connected, refreshSessions]);

  useEffect(() => {
    if (readyRef.current || !onReady) {
      return;
    }
    if (connected && (ui === 'chat' || ui === 'resume')) {
      readyRef.current = true;
      onReady();
    }
  }, [connected, onReady, ui]);

  const onNewChat = useCallback(() => {
    handleSelectSession(undefined);
  }, [handleSelectSession]);

  const handleDeleteSession = useCallback(
    async (id: string) => {
      try {
        await client.deleteSession(id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (sessionId === id) {
          handleSelectSession(undefined);
        }
      } catch (e) {
        console.error('Failed to delete session:', e);
      }
    },
    [client, sessionId, handleSelectSession]
  );

  const handleReaction = useCallback(
    async (type: 'like' | 'dislike', text?: string) => {
      try {
        const func = type === 'like' ? 'good' : 'bad';
        const args: Record<string, unknown> = {};
        if (text) {
          args.text = text;
        }
        await client.serverCall(func, args, sessionId);
      } catch {}
    },
    [client, sessionId]
  );

  const hasArtifacts = visibleArtifacts.length > 0;
  const sandboxLabel =
    sandboxLabelProp ??
    ({ host: undefined, devbox: 'Devbox', platform: 'Cloud' } as Record<string, string | undefined>)[
      launcherStore.defaultProfileName ?? 'host'
    ];

  // Confirm before switching INTO ``host`` post-first-message: the SDK's
  // unix_local.hydrate_workspace writes the snapshot back into the user's
  // host workspace, overwriting whatever was there. Pre-first-message
  // there's nothing in the container yet, so no warning is needed. Other
  // transitions (devbox→devbox, host→devbox) hydrate into a managed
  // container fs and don't touch the user's working tree.
  const handleSandboxChange = useCallback(
    (value: string) => {
      if (workspaceLocked && currentSandboxProfile !== 'host' && value === 'host') {
        const ok = window.confirm(
          "Switching to Host will apply the agent's container workspace back to your host files. " +
            'Any uncommitted local changes in your host workspace may be overwritten. Continue?'
        );
        if (!ok) return;
      }
      onSandboxChange?.(value);
    },
    [workspaceLocked, currentSandboxProfile, onSandboxChange]
  );
  const headerActions = {
    showArtifactsButton: hasArtifacts,
    onArtifactsToggle: hasArtifacts ? () => setArtifactsPanelOpen((v) => !v) : undefined,
  };

  let content: React.ReactNode = null;
  if (ui === 'resume') {
    content = (
      <div className="app flex-col">
        <Header agentName={agentName} />
        <div className="container-chat">
          <SessionList sessions={sessions} onSelect={handleSelectSession} />
        </div>
      </div>
    );
  } else {
    content = (
      <div className="app h-full flex flex-row min-w-0 relative">
        {!minimalMode && (
          <Sidebar
            open={sidebarOpen}
            sessions={sessions}
            selectedId={sessionId}
            onClose={() => setSidebarOpen(false)}
            onNewChat={onNewChat}
            onSelect={(id) => handleSelectSession(id)}
            onDelete={handleDeleteSession}
          />
        )}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {!minimalMode && (
            <Header
              agentName={agentName}
              onMenu={() => setSidebarOpen((v) => !v)}
              onArtifactsToggle={headerActions.onArtifactsToggle}
              showArtifactsButton={headerActions.showArtifactsButton}
            />
          )}
          <div className="flex-1 flex flex-row min-h-0 min-w-0">
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
              <div ref={setChatColumnEl} className="flex-1 min-h-0 min-w-0 overflow-x-hidden relative flex flex-col">
                <ArtifactPortalProvider target={chatColumnEl}>
                  <MessageList
                    items={items}
                    greeting={greeting}
                    suggestions={suggestions}
                    statusText={status}
                    thinking={thinking}
                    statusSpinner={statusSpinner}
                    preambleText={preamble}
                    welcomeText={welcomeText}
                    onApprovalDecision={handleApprovalDecision}
                    pendingPlan={pendingPlan}
                    onPlanDecision={onPlanDecision}
                    statusItalic={statusItalic}
                    onReaction={handleReaction}
                    currentRunId={runId}
                    toolStatusText={toolStatus}
                    onSubmitMessage={(text) => {
                      void handleSubmit(text);
                    }}
                    onStageContext={stageContext}
                  />
                </ArtifactPortalProvider>
                <AnimatePresence>
                  {!connected && (
                    <motion.div
                      className="absolute bottom-2 left-0 right-0 flex justify-center pointer-events-none z-10"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3, ease: 'easeOut' }}
                    >
                      <div className="inline-flex items-center gap-1.5 rounded-full bg-bgCardAlt px-3 py-1">
                        <svg
                          className="animate-spin h-3 w-3 text-textSubtle"
                          xmlns="http://www.w3.org/2000/svg"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          />
                        </svg>
                        <span className="text-xs text-textSubtle">Connecting…</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <GoalPanel snapshot={goalSnapshot} onDismiss={handleGoalDismiss} />
              <WakeupPanel snapshot={wakeupSnapshot} onDismiss={handleWakeupDismiss} />
              <Tasks tasks={tasks} />
              <WorkersPanel workers={visibleWorkers} onKill={handleWorkerKill} onDismiss={handleWorkerDismiss} />
              <BashJobs
                jobs={bashJobs}
                onKill={handleBashKill}
                onTail={handleBashTail}
                onWarmup={handleBashWarmup}
                onDismiss={handleBashDismiss}
              />
              <QueuedMessages
                items={queuedMessages}
                onCancel={(id) => {
                  if (!sessionId) {
                    return;
                  }
                  // Optimistic remove — the server's queue_changed broadcast
                  // is the source of truth and will overwrite this if the
                  // cancel raced with a drainer pop (cancel returns not_found).
                  setQueuedMessages((prev) => prev.filter((it) => it.id !== id));
                  client.cancelQueuedMessage(sessionId, id).catch(() => {});
                }}
              />
              <Notifications
                notifications={notifications}
                onDismiss={(id) => setNotifications((prev) => prev.filter((n) => n.id !== id))}
                onDismissAll={() => setNotifications([])}
              />
              <RecapPanel recap={recap} onDismiss={() => setRecap(null)} />
              <EscalationBanner escalation={escalation} />
              {stagedContext.length > 0 && (
                // MCP-Apps staged context chips. Each ``ui/update-model-context``
                // entry shows up here so the user knows what'll be sent on the
                // next turn; clicking × removes that entry (passing empty text
                // to ``stageContext`` clears the source).
                <div className="flex flex-wrap gap-1 px-3 py-1 text-[11px]">
                  {stagedContext.map((c) => (
                    <span
                      key={c.source}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-muted-foreground"
                      title={c.text}
                    >
                      <span className="truncate max-w-[240px]">
                        📎 {c.text.slice(0, 60)}
                        {c.text.length > 60 ? '…' : ''}
                      </span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => stageContext(c.source, '')}
                        aria-label="Remove staged context"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <Input
                disabled={!connected || !bootState.ready}
                thinking={thinking}
                onStop={handleStop}
                onSubmit={(text, files) => {
                  void handleSubmit(text, files);
                }}
                onVoiceSubmit={handleVoiceSubmit}
                voiceEnabled={voiceEnabled}
                workspacePath={workspaceSupported ? workspacePath : undefined}
                workspaceLocked={workspaceLocked}
                onWorkspaceClick={() => setWorkspacePickerOpen(true)}
                sandboxLabel={sandboxLabel}
                sandboxOptions={sandboxOptions}
                currentSandboxProfile={currentSandboxProfile}
                onSandboxChange={handleSandboxChange}
                sandboxLoading={!connected}
                sessionId={sessionId}
                onVoiceSessionCreated={(id: string) => setSessionId(id)}
                onVoiceClose={() => {
                  const sid = actor.getSnapshot().context.sessionId;
                  if (sid) {
                    handleSelectSession(sid);
                  }
                  refreshSessions();
                }}
              />
            </div>
            {isLargeScreen && artifactsPanelOpen && hasArtifacts && (
              <>
                <ResizableDivider
                  onResize={setArtifactsPanelWidth}
                  currentWidth={artifactsPanelWidth}
                  minWidth={180}
                  maxWidth={400}
                />
                <div className="flex-shrink-0 min-h-0 border-l border-bgCardAlt" style={{ width: artifactsPanelWidth }}>
                  <ArtifactsPanel
                    artifacts={visibleArtifacts}
                    onClose={() => setArtifactsPanelOpen(false)}
                    onScrollTo={handleScrollToArtifact}
                  />
                </div>
              </>
            )}
          </div>
        </div>
        {!isLargeScreen && artifactsPanelOpen && hasArtifacts && (
          <ArtifactsPanel
            artifacts={visibleArtifacts}
            onClose={() => setArtifactsPanelOpen(false)}
            onScrollTo={handleScrollToArtifact}
            asOverlay
          />
        )}
        {workspacePickerOpen && (
          <WorkspacePicker
            sessionId={sessionId}
            initialPath={workspacePath || undefined}
            onSelect={(path) => {
              setWorkspacePath(path);
              setWorkspacePickerOpen(false);
            }}
            onClose={() => setWorkspacePickerOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <OmniAgentsHeaderActionsProvider {...headerActions}>
      {content}
      {headerActionsTargetId ? (
        <OmniAgentsHeaderActionsPortal targetId={headerActionsTargetId} compact={headerActionsCompact} />
      ) : null}
    </OmniAgentsHeaderActionsProvider>
  );
}
