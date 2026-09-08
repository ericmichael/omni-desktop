import {
  BrainIcon,
  ChevronDownIcon,
  GlobeIcon,
  GlobeLockIcon,
  ListChecksIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from 'lucide-react';
import { useEffect, useMemo } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import { getConversationDraft, updateConversationDraft } from '@/renderer/omniagents-ui/conversation-drafts';
import { useSessionStoreField } from '@/renderer/omniagents-ui/hooks/use-chat-session';
import {
  type ListModelsResult,
  ModelCatalogClient,
  type ModelCatalogRpcTransport,
  type ReasoningEffort,
} from '@/renderer/omniagents-ui/rpc/model-catalog';
import type { ConversationSession } from '@/renderer/omniagents-ui/session/conversation-session';
import { SessionPanelStore } from '@/renderer/omniagents-ui/session/session-panels';

const REASONING_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh']);

// Completion reviews are always the guardian's job (or off) — there is
// no human route until a dedicated process prompt exists server-side.
type WorkflowReviewer = 'off' | 'guardian';

const WORKFLOW_REVIEWER_LABELS: Record<WorkflowReviewer, string> = {
  off: 'Checks off',
  guardian: 'Task checks on',
};

function isWorkflowReviewer(value: unknown): value is WorkflowReviewer {
  return value === 'off' || value === 'guardian';
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORTS.has(value as ReasoningEffort);
}

/** Result shape of the `sandbox.get_network` / `sandbox.set_network` RPCs. */
export type SandboxNetworkState = {
  ok: boolean;
  supported?: boolean;
  enabled?: boolean;
  reason?: string;
};

function reasonMessage(reasons: Array<{ message: string }> | undefined, fallback: string): string {
  return (
    reasons
      ?.map((reason) => reason.message)
      .filter(Boolean)
      .join('; ') || fallback
  );
}

/** Session-scoped model controls backed by the canonical v2 catalog RPCs. */
export function ModelSessionControls({
  sessionId,
  session,
  transport,
  disabled = false,
  connected = true,
  draftCatalog,
  approvalsSupported = false,
  onSetApprovalsReviewer,
  workflowSupported = false,
  onSetWorkflowReviewer,
  onGetSandboxNetwork,
  onSetSandboxNetwork,
}: {
  sessionId: string;
  session?: ConversationSession;
  transport: ModelCatalogRpcTransport;
  disabled?: boolean;
  connected?: boolean;
  draftCatalog?: ListModelsResult;
  /** True only when the runtime negotiated the approvalReviewer feature. */
  approvalsSupported?: boolean;
  onSetApprovalsReviewer?: (reviewer: 'user' | 'auto') => Promise<unknown>;
  /** True only when the runtime negotiated the workflowReviewer feature. */
  workflowSupported?: boolean;
  onSetWorkflowReviewer?: (reviewer: WorkflowReviewer) => Promise<unknown>;
  /** Probe the sandbox network toggle (`sandbox.get_network`). The pill
   *  renders only when this resolves `{ok: true, supported: true}` — host
   *  sessions and older runtimes reject or report unsupported. */
  onGetSandboxNetwork?: () => Promise<SandboxNetworkState>;
  onSetSandboxNetwork?: (enabled: boolean) => Promise<SandboxNetworkState>;
}) {
  const localState = useMemo(() => new SessionPanelStore(), [sessionId]);
  const state = session?.panels ?? localState;
  const catalog = useMemo(() => new ModelCatalogClient(transport), [transport]);
  const [models, setModels] = useSessionStoreField(state, 'models');
  const [activeModel, setActiveModel] = useSessionStoreField(state, 'activeModel');
  const [reasoningEffort, setReasoningEffort] = useSessionStoreField(state, 'reasoningEffort');
  const [approvalsReviewer, setApprovalsReviewer] = useSessionStoreField(state, 'approvalsReviewer');
  // 'guardian' is the config default (workflow.completion_reviewer); a null
  // session attribute means no override, so the control shows the default.
  const [workflowReviewer, setWorkflowReviewer] = useSessionStoreField(state, 'workflowReviewer');
  const [loading, setLoading] = useSessionStoreField(state, 'modelLoading');
  const [mutating, setMutating] = useSessionStoreField(state, 'modelMutating');
  const [error, setError] = useSessionStoreField(state, 'modelError');
  // null = unsupported / unknown → no pill. Deliberately NOT gated on the
  // shared `locked`: pulling the sandbox offline mid-run is the point of a
  // live toggle, so only its own mutation locks it.
  const [networkEnabled, setNetworkEnabled] = useSessionStoreField(state, 'networkEnabled');
  const [networkMutating, setNetworkMutating] = useSessionStoreField(state, 'networkMutating');

  useEffect(() => {
    if (!connected) {
      return;
    }
    let current = true;
    // A remote change invalidates only that selection, not the catalog or
    // other settings. Otherwise a push during first load drops all options.
    const freshModels = state.guardRead(['models']);
    const freshModel = state.guardRead(['activeModel']);
    const freshReasoning = state.guardRead(['reasoningEffort']);
    const freshApprovals = state.guardRead(['approvalsReviewer']);
    const freshWorkflow = state.guardRead(['workflowReviewer']);
    setLoading(true);
    const latest = state.guardRead(['modelLoading']);
    setError(null);
    const draft = getConversationDraft(sessionId);
    void (
      draftCatalog
        ? Promise.resolve({
            ...draftCatalog,
            session: {
              session_id: sessionId,
              active_model: draft.model ?? draftCatalog.default_model,
              reasoning_effort: draft.reasoning ?? null,
              approvals_reviewer: draft.approvals ?? 'user',
              workflow_reviewer: draft.workflow ?? 'guardian',
            },
          })
        : catalog.listModels({ sessionId })
    )
      .then((result) => {
        if ((!current && !session) || !latest()) {
          return;
        }
        if (freshModels()) {
          setModels(
            result.models.filter((model) => !model.hidden && model.availability.available && model.entitlement.entitled)
          );
        }
        if (freshModel()) {
          setActiveModel(result.session?.active_model ?? result.default_model);
        }
        if (freshReasoning()) {
          setReasoningEffort(result.session?.reasoning_effort ?? null);
        }
        if (freshApprovals()) {
          setApprovalsReviewer(result.session?.approvals_reviewer === 'auto' ? 'auto' : 'user');
        }
        if (freshWorkflow()) {
          const sessionWorkflowReviewer = result.session?.workflow_reviewer;
          setWorkflowReviewer(isWorkflowReviewer(sessionWorkflowReviewer) ? sessionWorkflowReviewer : 'guardian');
        }
      })
      .catch((cause: unknown) => {
        if ((current || session) && latest()) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if ((current || session) && latest()) {
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [catalog, sessionId, connected, draftCatalog, session, state]);

  useEffect(() => {
    if (!connected) {
      return;
    }
    if (!onGetSandboxNetwork) {
      setNetworkEnabled(null);
      return;
    }
    let current = true;
    const fresh = state.guardRead(['networkEnabled']);
    void onGetSandboxNetwork()
      .then((state) => {
        if ((current || session) && fresh()) {
          setNetworkEnabled(state.ok && state.supported ? (state.enabled ?? true) : null);
        }
      })
      .catch(() => {
        // Older runtimes reject the unknown function; host environments
        // have no lifecycle controller. Both mean: no pill.
        if ((current || session) && fresh()) {
          setNetworkEnabled(null);
        }
      });
    return () => {
      current = false;
    };
  }, [onGetSandboxNetwork, connected, session, state]);

  // A null server selection means "use the catalog default", not loading.
  const activeDescriptor = models.find((model) => (activeModel ? model.id === activeModel : model.is_default)) ?? null;
  const reasoningOptions = (activeDescriptor?.reasoning.options ?? []).filter(isReasoningEffort);
  const locked = disabled || !connected || loading || mutating;

  const chooseModel = async (model: string) => {
    if (model === (activeModel ?? activeDescriptor?.id) || locked) {
      return;
    }
    if (draftCatalog) {
      updateConversationDraft(sessionId, { model, reasoning: undefined });
      setActiveModel(model);
      setReasoningEffort(null);
      return;
    }
    setMutating(true);
    setError(null);
    const freshModel = state.guardRead(['activeModel']);
    const freshReasoning = state.guardRead(['reasoningEffort']);
    try {
      const result = await catalog.setSessionModel(sessionId, model);
      if (!result.ok || !result.model) {
        setError(reasonMessage(result.reasons, 'Omniagents refused the model change.'));
        return;
      }
      if (freshModel()) {
        setActiveModel(result.model);
      }
      if (freshReasoning()) {
        setReasoningEffort(result.reasoning_effort ?? null);
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(false);
    }
  };

  const chooseReasoning = async (effort: string) => {
    if (!isReasoningEffort(effort) || effort === reasoningEffort || locked) {
      return;
    }
    if (draftCatalog) {
      updateConversationDraft(sessionId, { reasoning: effort });
      setReasoningEffort(effort);
      return;
    }
    setMutating(true);
    setError(null);
    const freshModel = state.guardRead(['activeModel']);
    const freshReasoning = state.guardRead(['reasoningEffort']);
    try {
      const result = await catalog.setSessionReasoning(sessionId, effort);
      if (!result.ok || !result.reasoning_effort) {
        setError(reasonMessage(result.reasons, 'Omniagents refused the reasoning change.'));
        return;
      }
      if (freshReasoning()) {
        setReasoningEffort(result.reasoning_effort);
      }
      if (result.model && freshModel()) {
        setActiveModel(result.model);
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(false);
    }
  };

  const chooseReviewer = async (value: string) => {
    const reviewer = value === 'auto' ? 'auto' : 'user';
    if (reviewer === approvalsReviewer || locked || !onSetApprovalsReviewer) {
      return;
    }
    setMutating(true);
    setError(null);
    const fresh = state.guardRead(['approvalsReviewer']);
    try {
      await onSetApprovalsReviewer(reviewer);
      if (fresh()) {
        setApprovalsReviewer(reviewer);
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(false);
    }
  };

  const chooseWorkflowReviewer = async (value: string) => {
    if (!isWorkflowReviewer(value) || value === workflowReviewer || locked || !onSetWorkflowReviewer) {
      return;
    }
    setMutating(true);
    setError(null);
    const fresh = state.guardRead(['workflowReviewer']);
    try {
      await onSetWorkflowReviewer(value);
      if (fresh()) {
        setWorkflowReviewer(value);
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(false);
    }
  };

  const chooseNetwork = async (value: string) => {
    const enabled = value === 'on';
    if (networkEnabled === null || enabled === networkEnabled || networkMutating || !onSetSandboxNetwork) {
      return;
    }
    setNetworkMutating(true);
    setError(null);
    try {
      const result = await onSetSandboxNetwork(enabled);
      if (!result.ok) {
        setError(result.reason ?? 'Omniagents refused the network change.');
        return;
      }
      setNetworkEnabled(result.enabled ?? enabled);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setNetworkMutating(false);
    }
  };

  if (!loading && models.length === 0) {
    return error ? (
      <span className="text-xs text-destructive" role="status" title={error}>
        Model controls unavailable
      </span>
    ) : null;
  }

  return (
    // Row padding comes from the parent PillStrip row.
    <div className="flex min-w-0 items-center gap-1" data-testid="model-session-controls">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={locked || models.length === 0}
            className="h-7 max-w-64 gap-1.5 px-2 text-xs font-normal"
            title="Choose the model for this conversation"
          >
            <SparklesIcon className="size-3.5 text-primary" />
            <span className="truncate">{activeDescriptor?.label ?? activeModel ?? 'Loading models…'}</span>
            <ChevronDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-64">
          <DropdownMenuLabel>Conversation model</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={activeModel ?? activeDescriptor?.id}
            onValueChange={(value) => void chooseModel(value)}
          >
            {models.map((model) => (
              <DropdownMenuRadioItem key={model.id} value={model.id} disabled={model.deprecation.deprecated}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{model.label}</span>
                  {model.provider.name ? (
                    <span className="truncate text-xs text-muted-foreground">{model.provider.name}</span>
                  ) : null}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {reasoningOptions.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked}
              className="h-7 gap-1.5 px-2 text-xs font-normal capitalize"
              title="Choose reasoning effort for this conversation"
            >
              <BrainIcon className="size-3.5 text-primary" />
              {reasoningEffort ?? activeDescriptor?.reasoning.default ?? 'Reasoning'}
              <ChevronDownIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={reasoningEffort ?? activeDescriptor?.reasoning.default ?? undefined}
              onValueChange={(value) => void chooseReasoning(value)}
            >
              {reasoningOptions.map((effort) => (
                <DropdownMenuRadioItem key={effort} value={effort} className="capitalize">
                  {effort}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {(approvalsSupported && onSetApprovalsReviewer) || (workflowSupported && onSetWorkflowReviewer) ? (
        // One pill for both review knobs: the label tracks tool approvals
        // (the security-relevant state); step completion reviews live in
        // the same menu instead of spending a second pill on a setting
        // that rarely changes.
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked}
              className="h-7 gap-1.5 px-2 text-xs font-normal"
              title="Approvals and task checks for this conversation"
              data-testid="approvals-reviewer-control"
            >
              <ShieldCheckIcon
                className={`size-3.5 ${approvalsReviewer === 'auto' ? 'text-primary' : 'text-muted-foreground'}`}
              />
              {approvalsSupported && onSetApprovalsReviewer
                ? approvalsReviewer === 'auto'
                  ? 'Approve for me'
                  : 'Ask me'
                : WORKFLOW_REVIEWER_LABELS[workflowReviewer]}
              <ChevronDownIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            {approvalsSupported && onSetApprovalsReviewer ? (
              <>
                <DropdownMenuLabel>When the agent needs permission</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={approvalsReviewer} onValueChange={(value) => void chooseReviewer(value)}>
                  <DropdownMenuRadioItem value="user">Ask me first</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="auto">Approve for me</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </>
            ) : null}
            {workflowSupported && onSetWorkflowReviewer ? (
              <>
                {approvalsSupported && onSetApprovalsReviewer ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel className="flex items-center gap-1.5">
                  <ListChecksIcon className="size-3.5 text-muted-foreground" aria-hidden />
                  Double-check completed tasks
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={workflowReviewer}
                  onValueChange={(value) => void chooseWorkflowReviewer(value)}
                  data-testid="workflow-reviewer-group"
                >
                  <DropdownMenuRadioItem value="guardian">On</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {networkEnabled !== null && onSetSandboxNetwork ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={networkMutating || !connected}
              className="h-7 gap-1.5 px-2 text-xs font-normal"
              title="Sandbox internet access"
              data-testid="sandbox-network-control"
            >
              {networkEnabled ? (
                <GlobeIcon className="size-3.5 text-muted-foreground" />
              ) : (
                <GlobeLockIcon className="size-3.5 text-primary" />
              )}
              {networkEnabled ? 'Internet on' : 'Offline'}
              <ChevronDownIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            <DropdownMenuLabel>Internet access</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={networkEnabled ? 'on' : 'off'}
              onValueChange={(value) => void chooseNetwork(value)}
              data-testid="sandbox-network-group"
            >
              <DropdownMenuRadioItem value="on">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>On</span>
                  <span className="max-w-52 text-xs text-muted-foreground">The sandbox can reach the internet</span>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="off">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>Off</span>
                  <span className="max-w-52 text-xs text-muted-foreground">
                    No internet — work in the sandbox continues
                  </span>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {error ? (
        <span className="max-w-72 truncate text-xs text-destructive" role="status" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
