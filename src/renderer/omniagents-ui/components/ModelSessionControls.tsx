import { BrainIcon, ChevronDownIcon, SparklesIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/renderer/ds/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/renderer/ds/ui/dropdown-menu';
import {
  ModelCatalogClient,
  type ModelCatalogRpcTransport,
  type ModelDescriptor,
  type ReasoningEffort,
} from '@/renderer/omniagents-ui/rpc/model-catalog';

const REASONING_EFFORTS = new Set<ReasoningEffort>(['low', 'medium', 'high', 'xhigh']);

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
}: {
  sessionId: string;
  transport: ModelCatalogRpcTransport;
  disabled?: boolean;
}) {
  const catalog = useMemo(() => new ModelCatalogClient(transport), [transport]);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
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

  if (!loading && models.length === 0) {
    return error ? (
      <span className="text-xs text-destructive" role="status" title={error}>
        Model controls unavailable
      </span>
    ) : null;
  }

  return (
    <div className="flex min-h-8 items-center gap-1 px-3 pb-1" data-testid="model-session-controls">
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

      {error ? (
        <span className="max-w-72 truncate text-xs text-destructive" role="status" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
