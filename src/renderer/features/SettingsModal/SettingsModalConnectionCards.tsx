import { CircleCheck, CircleHelp, CircleX } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';

import { maskApiKey, probeForProvider } from '@/lib/provider-config';
import { cn } from '@/renderer/ds/cn';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Input } from '@/renderer/ds/ui/input';
import { Spinner } from '@/renderer/ds/ui/spinner';
import { probeFailureCopy } from '@/renderer/features/Onboarding/probe-copy';
import { emitter } from '@/renderer/services/ipc';
import type { ModelsConfig, ProviderEntry, ProviderProbeResult } from '@/shared/types';

type Health =
  | { state: 'checking' }
  | { state: 'ok' }
  | { state: 'failed'; result: Extract<ProviderProbeResult, { ok: false }> }
  | { state: 'unchecked' };

const PROVIDER_TYPE_LABELS: Record<ProviderEntry['type'], string> = {
  openai: 'OpenAI',
  azure: 'Azure',
  'openai-compatible': 'Local server',
  litellm: 'LiteLLM',
  'openai-oauth': 'ChatGPT',
};

/** Friendlier display name for the well-known entries the flows write. */
function displayName(name: string, provider: ProviderEntry): string {
  if (name === 'anthropic') {
    return 'Anthropic';
  }
  if (name === 'openai') {
    return 'OpenAI';
  }
  if (name === 'local') {
    return 'Local server';
  }
  if (name === 'codex') {
    return 'ChatGPT';
  }
  return `${name} (${PROVIDER_TYPE_LABELS[provider.type]})`;
}

type CardModel = {
  name: string;
  provider: ProviderEntry;
  probeable: boolean;
};

type ConnectionCardProps = {
  card: CardModel;
  defaultModel: string | null;
  /** Authoritative key fix: writes the key, persists, returns the re-probe result. */
  onFixKey: (providerName: string, apiKey: string) => Promise<ProviderProbeResult>;
};

const ConnectionCard = memo(({ card, defaultModel, onFixKey }: ConnectionCardProps) => {
  const { name, provider, probeable } = card;
  const [health, setHealth] = useState<Health>(probeable ? { state: 'checking' } : { state: 'unchecked' });
  const [fixing, setFixing] = useState(false);
  const [fixKey, setFixKey] = useState('');
  const [fixBusy, setFixBusy] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);

  useEffect(() => {
    const probe = probeForProvider(name, provider);
    if (!probe) {
      setHealth({ state: 'unchecked' });
      return;
    }
    let cancelled = false;
    setHealth({ state: 'checking' });
    emitter
      .invoke('util:validate-provider', probe)
      .then((result) => {
        if (!cancelled) {
          setHealth(result.ok ? { state: 'ok' } : { state: 'failed', result });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHealth({ state: 'failed', result: { ok: false, code: 'network', detail: 'probe failed' } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [name, provider]);

  const label = displayName(name, provider);
  const usesDefault = defaultModel?.startsWith(`${name}/`) ?? false;

  const handleStartFix = useCallback(() => {
    setFixing(true);
    setFixKey('');
    setFixError(null);
  }, []);

  const handleFixKeyChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setFixKey(e.target.value);
    setFixError(null);
  }, []);

  const handleApplyFix = useCallback(async () => {
    const key = fixKey.trim();
    if (!key || fixBusy) {
      return;
    }
    setFixBusy(true);
    setFixError(null);
    try {
      const result = await onFixKey(name, key);
      if (result.ok) {
        setHealth({ state: 'ok' });
        setFixing(false);
      } else {
        setFixError(probeFailureCopy(label, result));
      }
    } catch {
      setFixError('Something went wrong saving the key — try again.');
    } finally {
      setFixBusy(false);
    }
  }, [fixKey, fixBusy, onFixKey, name, label]);

  const handleCancelFix = useCallback(() => {
    setFixing(false);
    setFixError(null);
  }, []);

  return (
    <Card>
      <CardContent className="flex flex-col gap-6">
        <div className="flex items-center gap-4 w-full min-w-0">
          <div className="flex flex-col gap-0.5 flex-auto min-w-0">
            <span className="text-sm font-semibold text-foreground">{label}</span>
            <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>
              {provider.api_key ? `${maskApiKey(provider.api_key)} · ` : ''}
              {provider.base_url ? `${provider.base_url} · ` : ''}
              {usesDefault && defaultModel
                ? `Default: ${defaultModel}`
                : `${Object.keys(provider.models).length || 'discovered'} model${Object.keys(provider.models).length === 1 ? '' : 's'}`}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {health.state === 'checking' && <Spinner />}
            {health.state === 'ok' && (
              <>
                <CircleCheck className="text-success" />
                <span className={cn('text-xs text-muted-foreground', 'text-success')}>Connected</span>
              </>
            )}
            {health.state === 'failed' && (
              <>
                <CircleX className="text-destructive" />
                <span className={cn('text-xs text-muted-foreground', 'text-destructive')}>
                  {health.result.code === 'unauthorized' ? 'Key invalid' : 'Unreachable'}
                </span>
                {!fixing && health.result.code === 'unauthorized' && (
                  <Button size="sm" variant="ghost" onClick={handleStartFix}>
                    Fix
                  </Button>
                )}
              </>
            )}
            {health.state === 'unchecked' && (
              <>
                <CircleHelp className="text-muted-foreground" />
                <span className={cn('text-xs text-muted-foreground', 'text-muted-foreground')}>Not checked</span>
              </>
            )}
          </div>
        </div>

        {fixing && (
          <>
            <div className="flex items-center gap-2 mt-2">
              <div className="flex-auto min-w-0">
                <Input
                  type="password"
                  value={fixKey}
                  onChange={handleFixKeyChange}
                  placeholder="Paste a new API key"
                  autoFocus
                  disabled={fixBusy}
                />
              </div>
              <Button size="sm" variant="default" onClick={handleApplyFix} disabled={!fixKey.trim() || fixBusy}>
                {fixBusy ? 'Checking…' : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" onClick={handleCancelFix} disabled={fixBusy}>
                Cancel
              </Button>
            </div>
            {fixError && <span className="text-destructive text-xs">{fixError}</span>}
          </>
        )}
      </CardContent>
    </Card>
  );
});
ConnectionCard.displayName = 'ConnectionCard';

type Props = {
  config: ModelsConfig;
  onFixKey: (providerName: string, apiKey: string) => Promise<ProviderProbeResult>;
};

/**
 * The hero of the AI tab: one card per configured provider with live health
 * (free GET probes — no tokens spent) and an inline fix path for dead keys.
 * The Codex/ChatGPT entry's health is its sign-in status, rendered by the
 * sign-in card above, so it's skipped here.
 */
export const SettingsModalConnectionCards = memo(({ config, onFixKey }: Props) => {
  const entries = Object.entries(config.providers).filter(([, p]) => p.type !== 'openai-oauth');
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map(([name, provider]) => (
        <ConnectionCard
          key={`${name}:${provider.api_key ?? ''}:${provider.base_url ?? ''}`}
          card={{ name, provider, probeable: probeForProvider(name, provider) !== null }}
          defaultModel={config.default}
          onFixKey={onFixKey}
        />
      ))}
    </div>
  );
});
SettingsModalConnectionCards.displayName = 'SettingsModalConnectionCards';
