import { RotateCcw } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/renderer/ds/ui/alert';
import { Badge } from '@/renderer/ds/ui/badge';
import { Button } from '@/renderer/ds/ui/button';
import { Card, CardContent } from '@/renderer/ds/ui/card';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/renderer/ds/ui/field';
import { Input } from '@/renderer/ds/ui/input';
import { NativeSelect, NativeSelectOption } from '@/renderer/ds/ui/native-select';
import { Skeleton } from '@/renderer/ds/ui/skeleton';
import { Switch } from '@/renderer/ds/ui/switch';
import { Textarea } from '@/renderer/ds/ui/textarea';
import {
  settingsCardContentClassName,
  SettingsPane,
  SettingsSection,
} from '@/renderer/features/SettingsModal/SettingsLayout';
import {
  useProductManagement,
  useProductManagementRefresh,
  useProductManagementSnapshot,
} from '@/renderer/omniagents-ui/product-management-context';
import type {
  ConfigError,
  ConfigField,
  ConfigFieldLayer,
  ReloadMode,
  ReloadSummary,
} from '@/renderer/omniagents-ui/rpc/layered-config';
import { managementAdminApi } from '@/renderer/services/management-admin';

type PendingUpdates = Record<string, unknown>;

const GROUPS = [
  { id: 'runtime', label: 'Runtime' },
  { id: 'security', label: 'Security' },
  { id: 'mcp', label: 'MCP policy' },
  { id: 'audit', label: 'Audit & retention' },
  { id: 'authentication', label: 'Authentication' },
  { id: 'tracing', label: 'Tracing' },
] as const;

type GroupId = (typeof GROUPS)[number]['id'];

function groupFor(key: string): GroupId {
  if (key === 'allow_user_mcp_servers' || key.startsWith('security.mcp_')) {
    return 'mcp';
  }
  if (key.startsWith('security.audit.') || key.startsWith('security.sessions.')) {
    return 'audit';
  }
  if (key.startsWith('security.providers.')) {
    return 'authentication';
  }
  if (key.startsWith('security.')) {
    return 'security';
  }
  if (key.startsWith('tracing.')) {
    return 'tracing';
  }
  return 'runtime';
}

function idFor(key: string): string {
  return `runtime-policy-${key.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function layerLabel(layer: string | null): string {
  if (!layer) {
    return 'Not configured';
  }
  return layer === 'defaults' ? 'Built-in default' : `${layer[0]?.toUpperCase()}${layer.slice(1)} layer`;
}

function readOnlyLabel(reason: string | null): string {
  switch (reason) {
    case 'structural':
      return 'Defined by the product';
    case 'managed_policy':
      return 'Locked by managed policy';
    case 'environment':
      return 'Overridden by the environment';
    default:
      return reason ? `Read only: ${reason.replaceAll('_', ' ')}` : 'Read only';
  }
}

const reloadLabels: Record<ReloadMode, string> = {
  hot: 'Applies immediately',
  session: 'Next session',
  restart: 'Restart required',
};

function effectiveLayer(field: ConfigField): ConfigFieldLayer | undefined {
  return field.layers.at(-1);
}

function inheritedValue(field: ConfigField, writeTarget: string | null): unknown {
  return field.layers.filter((layer) => !writeTarget || layer.source !== writeTarget).at(-1)?.value;
}

function displayValue(field: ConfigField, update: unknown, hasUpdate: boolean, writeTarget: string | null): unknown {
  if (!hasUpdate) {
    return field.value;
  }
  return update === null ? inheritedValue(field, writeTarget) : update;
}

function fieldErrorMap(errors: ConfigError[]): Record<string, string> {
  return Object.fromEntries(errors.map((error) => [error.key, error.message]));
}

function ReloadBadge({ mode }: { mode: ReloadMode }) {
  return <Badge variant={mode === 'restart' ? 'destructive' : 'outline'}>{reloadLabels[mode]}</Badge>;
}

type RuntimePolicyFieldProps = {
  field: ConfigField;
  update: unknown;
  hasUpdate: boolean;
  writeTarget: string | null;
  error?: string;
  onChange: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
};

const RuntimePolicyField = memo(
  ({ field, update, hasUpdate, writeTarget, error, onChange, onReset }: RuntimePolicyFieldProps) => {
    const id = idFor(field.key);
    const value = displayValue(field, update, hasUpdate, writeTarget);
    const resetting = hasUpdate && update === null;
    const ownsValue = field.layers.some((layer) => writeTarget !== null && layer.source === writeTarget);
    const provenance = effectiveLayer(field);
    const disabled = field.read_only || resetting;

    const onTextChange = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => onChange(field.key, event.target.value),
      [field.key, onChange]
    );
    const onIntegerChange = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => {
        const raw = event.target.value;
        onChange(field.key, /^-?\d+$/.test(raw) ? Number(raw) : raw);
      },
      [field.key, onChange]
    );
    const onSelectChange = useCallback(
      (event: ChangeEvent<HTMLSelectElement>) => onChange(field.key, event.target.value),
      [field.key, onChange]
    );
    const onListChange = useCallback(
      (event: ChangeEvent<HTMLTextAreaElement>) =>
        onChange(
          field.key,
          event.target.value
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean)
        ),
      [field.key, onChange]
    );
    const reset = useCallback(() => onReset(field.key), [field.key, onReset]);

    const control = (() => {
      if (field.secret) {
        return (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            value={typeof update === 'string' ? update : ''}
            placeholder={field.is_set && !resetting ? 'Replace configured value' : 'Enter a value'}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            onChange={onTextChange}
          />
        );
      }
      if (field.type === 'boolean') {
        return (
          <Switch
            id={id}
            checked={value === true}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            onCheckedChange={(checked) => onChange(field.key, checked)}
          />
        );
      }
      if (field.type === 'string_list') {
        return (
          <Textarea
            id={id}
            value={Array.isArray(value) ? value.join('\n') : ''}
            placeholder="One value per line"
            disabled={disabled}
            aria-invalid={Boolean(error)}
            onChange={onListChange}
          />
        );
      }
      if (field.allowed_values?.length) {
        return (
          <NativeSelect
            id={id}
            className="min-w-48"
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            onChange={onSelectChange}
          >
            {!field.is_set && <NativeSelectOption value="">Choose a value</NativeSelectOption>}
            {field.allowed_values.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {option}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        );
      }
      return (
        <Input
          id={id}
          type={field.type === 'integer' ? 'number' : 'text'}
          value={value === undefined || value === null ? '' : String(value)}
          min={field.minimum}
          max={field.maximum}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          onChange={field.type === 'integer' ? onIntegerChange : onTextChange}
        />
      );
    })();

    return (
      <Field data-invalid={Boolean(error)} className="gap-2 border-b border-border pb-5 last:border-b-0 last:pb-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
            <FieldDescription>{field.description}</FieldDescription>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            <ReloadBadge mode={field.reload} />
            <Badge variant="secondary" title={provenance?.source ?? undefined}>
              {layerLabel(field.effective_layer)}
            </Badge>
            {field.secret && <Badge variant="outline">{field.is_set && !resetting ? 'Secret set' : 'Not set'}</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className={field.type === 'boolean' ? 'flex flex-1 justify-end' : 'min-w-0 flex-1'}>{control}</div>
          {!field.read_only && (ownsValue || hasUpdate) && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Reset ${field.label}`}
              title="Reset to the inherited value"
              disabled={resetting}
              onClick={reset}
            >
              <RotateCcw />
            </Button>
          )}
        </div>
        {field.read_only && <p className="text-xs text-muted-foreground">{readOnlyLabel(field.read_only_reason)}</p>}
        {resetting && <p className="text-xs text-muted-foreground">Will reset to the inherited value when saved.</p>}
        {field.is_set && (
          <p className="break-all text-xs text-muted-foreground">
            Effective source: {provenance?.source ?? layerLabel(field.effective_layer)}
          </p>
        )}
        <FieldError>{error}</FieldError>
      </Field>
    );
  }
);
RuntimePolicyField.displayName = 'RuntimePolicyField';

function savedMessage(reload: ReloadSummary): string {
  const parts: string[] = [];
  if (reload.hot.length) {
    parts.push('immediate changes applied');
  }
  if (reload.session.length) {
    parts.push('session changes apply on the next session');
  }
  if (reload.restart.length) {
    parts.push('some changes require a runtime restart');
  }
  return parts.length ? parts.join('; ') : 'policy saved';
}

export const SettingsModalRuntimePolicyTab = memo(() => {
  const management = useProductManagement();
  const snapshot = useProductManagementSnapshot();
  const refresh = useProductManagementRefresh();
  const [updates, setUpdates] = useState<PendingUpdates>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedReload, setSavedReload] = useState<ReloadSummary | null>(null);

  const config = snapshot.config.data;
  const writeTarget = config?.layers.find((layer) => layer.writable)?.write_target ?? null;
  const dirty = Object.keys(updates).length > 0;
  const canWrite = management.mutationCapabilities.validateConfig && management.mutationCapabilities.writeConfig;

  const grouped = useMemo(() => {
    const fields = config?.fields ?? [];
    return GROUPS.map((group) => ({
      ...group,
      fields: fields.filter((field) => groupFor(field.key) === group.id),
    })).filter((group) => group.fields.length > 0);
  }, [config?.fields]);

  const change = useCallback((key: string, value: unknown) => {
    setUpdates((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      const { [key]: _, ...rest } = current;
      return rest;
    });
    setError(null);
    setSavedReload(null);
  }, []);

  const reset = useCallback((key: string) => change(key, null), [change]);

  const discard = useCallback(() => {
    setUpdates({});
    setFieldErrors({});
    setError(null);
    setSavedReload(null);
  }, []);

  const save = useCallback(async () => {
    if (!dirty || !canWrite) {
      return;
    }
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const validation = await managementAdminApi.validateConfig(updates);
      if (!validation.valid) {
        setFieldErrors(fieldErrorMap(validation.errors));
        setError('Review the highlighted policy settings. Nothing was written.');
        return;
      }
      const result = await managementAdminApi.writeConfig(updates);
      if (!result.ok) {
        setFieldErrors(fieldErrorMap(result.errors));
        setError('The policy changed before it could be saved. Review the highlighted settings.');
        return;
      }
      setUpdates({});
      setSavedReload(result.reload);
      try {
        await refresh();
      } catch (refreshError) {
        setError(
          `Policy was saved, but the authoritative refresh failed: ${
            refreshError instanceof Error ? refreshError.message : String(refreshError)
          }`
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save runtime policy');
    } finally {
      setSaving(false);
    }
  }, [canWrite, dirty, refresh, updates]);

  if (
    !config &&
    (management.status === 'starting' || management.status === 'connecting' || snapshot.config.status === 'loading')
  ) {
    return (
      <SettingsPane aria-label="Runtime Policy">
        <SettingsSection title="Runtime policy">
          <Card>
            <CardContent className={settingsCardContentClassName}>
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </CardContent>
          </Card>
        </SettingsSection>
      </SettingsPane>
    );
  }

  if (!config) {
    const unsupported = snapshot.config.status === 'unsupported' || !snapshot.experimental.configRead;
    return (
      <SettingsPane aria-label="Runtime Policy">
        <SettingsSection title="Runtime policy">
          <Alert variant={unsupported ? 'default' : 'destructive'}>
            <AlertTitle>{unsupported ? 'Not supported by this runtime' : 'Runtime policy unavailable'}</AlertTitle>
            <AlertDescription>
              {unsupported
                ? 'Update the Omni runtime to manage layered policy from Desktop.'
                : snapshot.config.error || management.error || 'Connect the product runtime and try again.'}
              {!unsupported && (
                <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void refresh()}>
                  Try again
                </Button>
              )}
            </AlertDescription>
          </Alert>
        </SettingsSection>
      </SettingsPane>
    );
  }

  return (
    <SettingsPane aria-label="Runtime Policy">
      <SettingsSection
        title="Runtime policy"
        description="Omniagents describes these settings and their effective source. Changes are validated as one atomic batch."
      >
        {!canWrite && (
          <Alert>
            <AlertTitle>Read only</AlertTitle>
            <AlertDescription>
              This runtime supports policy inspection but not validated policy writes.
            </AlertDescription>
          </Alert>
        )}
        {grouped.map((group) => (
          <div key={group.id} className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">{group.label}</h4>
            <Card>
              <CardContent className={settingsCardContentClassName}>
                {group.fields.map((field) => (
                  <RuntimePolicyField
                    key={field.key}
                    field={field}
                    update={updates[field.key]}
                    hasUpdate={Object.hasOwn(updates, field.key)}
                    writeTarget={writeTarget}
                    error={fieldErrors[field.key]}
                    onChange={change}
                    onReset={reset}
                  />
                ))}
              </CardContent>
            </Card>
          </div>
        ))}
        {savedReload && (
          <Alert>
            <AlertTitle>Runtime policy saved</AlertTitle>
            <AlertDescription>{savedMessage(savedReload)}.</AlertDescription>
          </Alert>
        )}
        {(dirty || error || saving) && (
          <div className="flex flex-col gap-2">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={discard}>
                Discard
              </Button>
              <Button type="button" size="sm" disabled={!dirty || saving || !canWrite} onClick={() => void save()}>
                {saving ? 'Validating…' : 'Validate & save'}
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>
    </SettingsPane>
  );
});
SettingsModalRuntimePolicyTab.displayName = 'SettingsModalRuntimePolicyTab';
