import { BrainIcon, ChevronDownIcon, ListChecksIcon, ShieldCheckIcon, SparklesIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

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
import {
  ModelCatalogClient,
  type ModelCatalogRpcTransport,
  type ModelDescriptor,
  type ReasoningEffort,
} from '@/renderer/omniagents-ui/rpc/model-catalog';

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
  transport,
  disabled = false,
  approvalsSupported = false,
  onSetApprovalsReviewer,
  workflowSupported = false,
  onSetWorkflowReviewer,
}: {
  sessionId: string;
  transport: ModelCatalogRpcTransport;
  disabled?: boolean;
  /** True only when the runtime negotiated the approvalReviewer feature. */
  approvalsSupported?: boolean;
  onSetApprovalsReviewer?: (reviewer: 'user' | 'auto') => Promise<unknown>;
  /** True only when the runtime negotiated the workflowReviewer feature. */
  workflowSupported?: boolean;
  onSetWorkflowReviewer?: (reviewer: WorkflowReviewer) => Promise<unknown>;
}) {
  const catalog = useMemo(() => new ModelCatalogClient(transport), [transport]);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [approvalsReviewer, setApprovalsReviewer] = useState<'user' | 'auto'>('user');
  // 'guardian' is the config default (workflow.completion_reviewer); a null
  // session attribute means no override, so the control shows the default.
  const [workflowReviewer, setWorkflowReviewer] = useState<WorkflowReviewer>('guardian');
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void catalog
      .listModels({ sessionId })
      .then((result) => {
        if (!current) {
          return;
        }
        setModels(
          result.models.filter((model) => !model.hidden && model.availability.available && model.entitlement.entitled)
        );
        setActiveModel(result.session?.active_model ?? result.default_model);
        setReasoningEffort(result.session?.reasoning_effort ?? null);
        setApprovalsReviewer(result.session?.approvals_reviewer === 'auto' ? 'auto' : 'user');
        const sessionWorkflowReviewer = result.session?.workflow_reviewer;
        setWorkflowReviewer(isWorkflowReviewer(sessionWorkflowReviewer) ? sessionWorkflowReviewer : 'guardian');
      })
      .catch((cause: unknown) => {
        if (current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [catalog, sessionId]);

  const activeDescriptor = models.find((model) => model.id === activeModel) ?? null;
  const reasoningOptions = (activeDescriptor?.reasoning.options ?? []).filter(isReasoningEffort);
  const locked = disabled || loading || mutating;

  const chooseModel = async (model: string) => {
    if (model === activeModel || locked) {
      return;
    }
    setMutating(true);
    setError(null);
    try {
      const result = await catalog.setSessionModel(sessionId, model);
      if (!result.ok || !result.model) {
        setError(reasonMessage(result.reasons, 'Omniagents refused the model change.'));
        return;
      }
      setActiveModel(result.model);
      setReasoningEffort(result.reasoning_effort ?? null);
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
    setMutating(true);
    setError(null);
    try {
      const result = await catalog.setSessionReasoning(sessionId, effort);
      if (!result.ok || !result.reasoning_effort) {
        setError(reasonMessage(result.reasons, 'Omniagents refused the reasoning change.'));
        return;
      }
      setReasoningEffort(result.reasoning_effort);
      if (result.model) {
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
    try {
      await onSetApprovalsReviewer(reviewer);
      setApprovalsReviewer(reviewer);
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
    try {
      await onSetWorkflowReviewer(value);
      setWorkflowReviewer(value);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(false);
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
          <DropdownMenuRadioGroup value={activeModel ?? undefined} onValueChange={(value) => void chooseModel(value)}>
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

      {error ? (
        <span className="max-w-72 truncate text-xs text-destructive" role="status" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
