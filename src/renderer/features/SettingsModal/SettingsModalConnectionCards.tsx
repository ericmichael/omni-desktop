import { makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircle20Filled, ErrorCircle20Filled, QuestionCircle20Regular } from '@fluentui/react-icons';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';

import { maskApiKey, probeForProvider } from '@/lib/provider-config';
import { Button, Caption1, Card, Input, Spinner } from '@/renderer/ds';
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

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, width: '100%', minWidth: 0 },
  body: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: 0 },
  name: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  detail: { color: tokens.colorNeutralForeground2 },
  health: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 },
  healthOk: { color: tokens.colorPaletteGreenForeground1 },
  healthBad: { color: tokens.colorPaletteRedForeground1 },
  healthMuted: { color: tokens.colorNeutralForeground3 },
  fixRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
  },
  fixInput: { flex: '1 1 auto', minWidth: 0 },
  fixError: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
});

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
  const styles = useStyles();
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
      <div className={styles.row}>
        <div className={styles.body}>
          <span className={styles.name}>{label}</span>
          <Caption1 className={styles.detail}>
            {provider.api_key ? `${maskApiKey(provider.api_key)} · ` : ''}
            {provider.base_url ? `${provider.base_url} · ` : ''}
            {usesDefault && defaultModel
              ? `Default: ${defaultModel}`
              : `${Object.keys(provider.models).length || 'discovered'} model${Object.keys(provider.models).length === 1 ? '' : 's'}`}
          </Caption1>
        </div>
        <div className={styles.health}>
          {health.state === 'checking' && <Spinner size="sm" />}
          {health.state === 'ok' && (
            <>
              <CheckmarkCircle20Filled className={styles.healthOk} />
              <Caption1 className={styles.healthOk}>Connected</Caption1>
            </>
          )}
          {health.state === 'failed' && (
            <>
              <ErrorCircle20Filled className={styles.healthBad} />
              <Caption1 className={styles.healthBad}>
                {health.result.code === 'unauthorized' ? 'Key invalid' : 'Unreachable'}
              </Caption1>
              {!fixing && health.result.code === 'unauthorized' && (
                <Button size="sm" variant="ghost" onClick={handleStartFix}>
                  Fix
                </Button>
              )}
            </>
          )}
          {health.state === 'unchecked' && (
            <>
              <QuestionCircle20Regular className={styles.healthMuted} />
              <Caption1 className={styles.healthMuted}>Not checked</Caption1>
            </>
          )}
        </div>
      </div>

      {fixing && (
        <>
          <div className={styles.fixRow}>
            <div className={styles.fixInput}>
              <Input
                type="password"
                size="sm"
                value={fixKey}
                onChange={handleFixKeyChange}
                placeholder="Paste a new API key"
                autoFocus
                disabled={fixBusy}
              />
            </div>
            <Button size="sm" variant="primary" onClick={handleApplyFix} isDisabled={!fixKey.trim() || fixBusy}>
              {fixBusy ? 'Checking…' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancelFix} isDisabled={fixBusy}>
              Cancel
            </Button>
          </div>
          {fixError && <span className={styles.fixError}>{fixError}</span>}
        </>
      )}
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
  const styles = useStyles();
  const entries = Object.entries(config.providers).filter(([, p]) => p.type !== 'openai-oauth');
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className={styles.list}>
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
